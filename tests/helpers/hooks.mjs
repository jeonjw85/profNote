function dependenciesChanged(previous, next) {
  return previous === undefined || next === undefined || previous.length !== next.length
    || next.some((value, index) => !Object.is(value, previous[index]));
}

export function createHookHarness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let rendering = false;
  let rerender = false;
  const nextSlot = (initialize) => slots[cursor++] ??= initialize();
  const react = {
    useState(initial) {
      const slot = nextSlot(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [slot.value, (value) => {
        const next = typeof value === "function" ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) {
          slot.value = next;
          if (rendering) rerender = true;
        }
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
    useMemo(factory, dependencies) {
      const slot = nextSlot(() => ({}));
      if (dependenciesChanged(slot.dependencies, dependencies)) {
        slot.dependencies = dependencies;
        slot.value = factory();
      }
      return slot.value;
    },
    useEffect(effect, dependencies) {
      const slot = nextSlot(() => ({}));
      if (dependenciesChanged(slot.dependencies, dependencies)) {
        effects.push(() => {
          slot.dependencies = dependencies;
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
    useImperativeHandle(ref, create, dependencies) {
      react.useEffect(() => {
        if (!ref) return;
        ref.current = create();
        return () => { ref.current = null; };
      }, dependencies === undefined ? undefined : [...dependencies, ref]);
    },
  };
  return {
    react,
    render(hook) {
      let result;
      let attempts = 0;
      do {
        if (++attempts > 25) throw new Error("Too many render-phase updates");
        cursor = 0;
        effects = [];
        rerender = false;
        rendering = true;
        try { result = hook(); } finally { rendering = false; }
      } while (rerender);
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
