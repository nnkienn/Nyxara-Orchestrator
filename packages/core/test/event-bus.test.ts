import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/index.js";

interface TestEventMap {
  readonly "test.ping": { readonly value: number };
  readonly "test.pong": { readonly value: number };
}

describe("EventBus listener isolation", () => {
  it("keeps delivering to healthy listeners when one throws", () => {
    const received: string[] = [];
    const reports: string[] = [];
    const bus = new EventBus<TestEventMap>(({ eventName }) => {
      reports.push(eventName);
    });

    bus.on("test.ping", () => received.push("A"));
    bus.on("test.ping", () => {
      throw new Error("listener B is broken");
    });
    bus.on("test.ping", () => received.push("C"));

    expect(() => bus.emit("test.ping", { value: 1 })).not.toThrow();
    expect(received).toEqual(["A", "C"]);
    expect(reports).toEqual(["test.ping"]);
  });

  it("reports every failing listener without aborting the emit", () => {
    const reports: unknown[] = [];
    const bus = new EventBus<TestEventMap>((report) => reports.push(report));
    const healthy = vi.fn();

    bus.on("test.ping", () => {
      throw new Error("first");
    });
    bus.on("test.ping", () => {
      throw new Error("second");
    });
    bus.on("test.ping", healthy);

    bus.emit("test.ping", { value: 1 });

    expect(reports).toHaveLength(2);
    expect(healthy).toHaveBeenCalledOnce();
  });

  it("survives a throwing error observer", () => {
    const bus = new EventBus<TestEventMap>(() => {
      throw new Error("observer is broken too");
    });
    const healthy = vi.fn();

    bus.on("test.ping", () => {
      throw new Error("listener is broken");
    });
    bus.on("test.ping", healthy);

    expect(() => bus.emit("test.ping", { value: 1 })).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it("swallows nothing when no listener throws", () => {
    const reports: unknown[] = [];
    const bus = new EventBus<TestEventMap>((report) => reports.push(report));
    const listener = vi.fn();

    bus.on("test.ping", listener);
    bus.emit("test.ping", { value: 7 });

    expect(listener).toHaveBeenCalledWith({ value: 7 });
    expect(reports).toEqual([]);
  });

  it("isolates failures per event and keeps other events working", () => {
    const bus = new EventBus<TestEventMap>();
    const pong = vi.fn();

    bus.on("test.ping", () => {
      throw new Error("ping listener is broken");
    });
    bus.on("test.pong", pong);

    bus.emit("test.ping", { value: 1 });
    bus.emit("test.pong", { value: 2 });

    expect(pong).toHaveBeenCalledWith({ value: 2 });
  });

  it("unsubscribes a listener and retains no payload history", () => {
    const bus = new EventBus<TestEventMap>();
    const listener = vi.fn();

    const unsubscribe = bus.on("test.ping", listener);
    bus.emit("test.ping", { value: 1 });
    unsubscribe();
    bus.emit("test.ping", { value: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount("test.ping")).toBe(0);
    // A late subscriber must not receive anything that was emitted earlier.
    const late = vi.fn();
    bus.on("test.ping", late);
    expect(late).not.toHaveBeenCalled();
  });

  it("tolerates a listener that unsubscribes during dispatch", () => {
    const bus = new EventBus<TestEventMap>();
    const order: string[] = [];

    const unsubscribe = bus.on("test.ping", () => {
      order.push("first");
      unsubscribe();
    });
    bus.on("test.ping", () => order.push("second"));

    bus.emit("test.ping", { value: 1 });
    bus.emit("test.ping", { value: 2 });

    expect(order).toEqual(["first", "second", "second"]);
  });
});
