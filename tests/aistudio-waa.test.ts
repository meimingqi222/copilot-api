import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  createWaaRuntime,
  setWaaSettleMsForTest,
} from "~/services/aistudio/waa"

beforeEach(() => setWaaSettleMsForTest(0))
afterEach(() => setWaaSettleMsForTest(3000))

test("WAA supports unqualified Window getters through the vm context receiver", async () => {
  const runtime = createWaaRuntime({
    cookie: "SAPISID=synthetic",
    challenge: { globalName: "fixture", program: "synthetic" },
    interpreter: `globalThis.fixture = { a(program, ready) {
      const page = document;
      if (page !== globalThis.document) throw new Error('Wrong document');
      const getter = Object.getOwnPropertyDescriptor(globalThis, 'document').get;
      let rejectsFake = false;
      try { getter.call({}); } catch { rejectsFake = true; }
      if (!rejectsFake) throw new Error('Unbranded receiver accepted');
      ready((done) => done('proof-ok'), () => {});
    } }`,
  })
  try {
    expect(await runtime.proof("synthetic")).toBe("proof-ok")
  } finally {
    runtime.close()
  }
}, 10000)
