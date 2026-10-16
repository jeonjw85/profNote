use keyring::Entry;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credentials {
    pub openai_api_key: String,
    pub hugging_face_token: String,
}

pub fn load() -> Result<Option<Credentials>, AppError> {
    read_entry(&system_entry()?)
}

pub fn save(credentials: &Credentials) -> Result<(), AppError> {
    write_entry(&system_entry()?, credentials)
}

fn system_entry() -> Result<Entry, AppError> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        Entry::new("kr.jjw.profNote", "credentials").map_err(storage_error)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err(AppError::CredentialStorage(
            "system credential storage is unsupported on this platform".into(),
        ))
    }
}

fn storage_error(error: keyring::Error) -> AppError {
    let message = match error {
        keyring::Error::NoStorageAccess(_) => {
            "system credential storage is locked or access was denied"
        }
        keyring::Error::TooLong(_, _) => "credentials exceed the system storage limit",
        _ => "system credential storage is unavailable",
    };
    AppError::CredentialStorage(message.into())
}

fn read_entry(entry: &Entry) -> Result<Option<Credentials>, AppError> {
    match entry.get_password() {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| {
            AppError::CredentialStorage("stored credentials have an invalid format".into())
        }),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(storage_error(error)),
    }
}

fn write_entry(entry: &Entry, credentials: &Credentials) -> Result<(), AppError> {
    let value = serde_json::to_string(credentials)
        .map_err(|_| AppError::CredentialStorage("could not encode credentials".into()))?;
    entry.set_password(&value).map_err(storage_error)?;
    if read_entry(entry)?.as_ref() != Some(credentials) {
        return Err(AppError::CredentialStorage(
            "credential storage verification failed".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Credentials, read_entry, write_entry};
    use keyring::{Entry, Error, mock::MockCredential};

    fn entry() -> Entry {
        Entry::new_with_credential(Box::new(MockCredential::default()))
    }

    fn credentials() -> Credentials {
        Credentials {
            openai_api_key: "dummy-api-key".into(),
            hugging_face_token: "dummy-hf-token".into(),
        }
    }

    #[test]
    fn missing_credentials_are_distinct_from_inaccessible_storage() {
        let entry = entry();
        assert!(read_entry(&entry).expect("empty store").is_none());
        entry
            .get_credential()
            .downcast_ref::<MockCredential>()
            .expect("mock")
            .set_error(Error::NoStorageAccess(Box::new(std::io::Error::other(
                "locked",
            ))));
        assert!(read_entry(&entry).is_err());
    }

    #[test]
    fn both_credentials_round_trip_in_one_secure_entry() {
        let entry = entry();
        write_entry(&entry, &credentials()).expect("save credentials");
        assert!(read_entry(&entry).expect("read credentials") == Some(credentials()));
        write_entry(
            &entry,
            &Credentials {
                openai_api_key: "".into(),
                hugging_face_token: "".into(),
            },
        )
        .expect("clear credential values");
        let saved = read_entry(&entry)
            .expect("read cleared entry")
            .expect("empty entry retained");
        assert!(saved.openai_api_key.is_empty());
        assert!(saved.hugging_face_token.is_empty());
    }

    #[test]
    fn failed_secure_write_preserves_previous_credentials() {
        let entry = entry();
        write_entry(&entry, &credentials()).expect("initial save");
        entry
            .get_credential()
            .downcast_ref::<MockCredential>()
            .expect("mock")
            .set_error(Error::NoStorageAccess(Box::new(std::io::Error::other(
                "denied",
            ))));
        assert!(
            write_entry(
                &entry,
                &Credentials {
                    openai_api_key: "replacement".into(),
                    hugging_face_token: "".into()
                }
            )
            .is_err()
        );
        assert!(read_entry(&entry).expect("read original") == Some(credentials()));
    }

    #[test]
    fn corrupt_secure_entries_fail_without_exposing_secret_contents() {
        let entry = entry();
        entry
            .set_password("{dummy-sensitive-corrupt-data}")
            .expect("corrupt fixture");
        let error = read_entry(&entry)
            .err()
            .expect("reject malformed entry")
            .to_string();
        assert!(!error.contains("dummy-sensitive"));
    }
}
