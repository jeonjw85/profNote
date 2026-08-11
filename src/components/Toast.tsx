import type { ReactNode } from "react";
import styles from "./Toast.module.css";

interface ToastProps {
    tone: "info" | "error";
    children: ReactNode;
    onDismiss?: () => void;
}

export function Toast({ tone, children, onDismiss }: ToastProps) {
    return (
        <button
            type="button"
            className={`${styles.toast} ${tone === "error" ? styles.error : ""}`}
            onClick={onDismiss}
            role="status"
        >
            {children}
        </button>
    );
}
