function dependenciesChanged(previous, next) {
  return previous === undefined || next === undefined || previous.length !== next.length
    || next.some((value, index) => !Object.is(value, previous[index]));
}

export function createHookHarness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const nextSlot = (initialize) => slots[cursor++] ??= initialize();
  const react = {
    useState(initial) {
      const slot = nextSlot(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [slot.value, (value) => {
        slot.value = typeof value === "function" ? value(slot.value) : value;
      }];
    },
    useRef(initial) {
      return nextSlot(() => ({ current: initial }));
    },
    useCallback(callback, dependencies) {
      const slot = nextSlot(() => ({}));
      if (dependenciesChanged(slot.dependencies, dependencies)) {
        slot.dependencies = dependencies;
        slot.value = callback;
      }
      return slot.value;
    },
    useEffect(effect, dependencies) {
      const slot = nextSlot(() => ({}));
      if (dependenciesChanged(slot.dependencies, dependencies)) {
        slot.dependencies = dependencies;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
  };
  return {
    react,
    render(hook) {
      cursor = 0;
      const result = hook();
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return result;
    },
    cleanup() {
      slots.forEach((slot) => slot.cleanup?.());
    },
  };
}
