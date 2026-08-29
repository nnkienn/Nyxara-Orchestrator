import { describe, expect, it } from "vitest";
import { RepairCycleStore } from "../src/index.js";

describe("RepairCycleStore", () => {
  it("keeps bounded structured cycle state and terminal timestamps", () => {
    const store = new RepairCycleStore(2, () => "2026-08-30T00:00:00.000Z");
    store.begin({
      taskId: "T1",
      cycle: 1,
      executorAttempts: 0,
      validationAttempts: 0,
      reviewAttempts: 0,
    });
    store.update(1, "validating", { validationAttempts: 1 });
    store.update(1, "passed");
    store.begin({
      taskId: "T1",
      cycle: 2,
      executorAttempts: 1,
      validationAttempts: 1,
      reviewAttempts: 0,
    });
    store.begin({
      taskId: "T1",
      cycle: 3,
      executorAttempts: 2,
      validationAttempts: 2,
      reviewAttempts: 1,
    });

    expect(store.list()).toHaveLength(2);
    expect(store.list().map((state) => state.cycle)).toEqual([2, 3]);
    expect(store.current()).toMatchObject({ cycle: 3, status: "repairing" });
    expect(store.list()[0]).not.toHaveProperty("completedAt");
  });
});

