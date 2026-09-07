export function configurationProxy<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return new Proxy(value, {
    get: (target, property) => configurationProxy(Reflect.get(target, property)),
    set: () => { throw new TypeError("Configuration is read-only"); },
    deleteProperty: () => { throw new TypeError("Configuration is read-only"); },
    defineProperty: () => { throw new TypeError("Configuration is read-only"); },
  });
}
