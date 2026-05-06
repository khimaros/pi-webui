import { test } from "node:test";
import assert from "node:assert/strict";
import { createModalController } from "../public/modal-controller.mjs";

// regression: when a user picks an item from a ctx.ui.select picker over the
// webui bridge, the select promise must resolve to the chosen item — not to
// the cancel value. the ext_ui bridge installs a cancel handler that replies
// with undefined for dismissals, so committing must definitively suppress it
// before any teardown that would otherwise fire it.

test("dismiss fires the registered cancel handler exactly once", () => {
	let calls = 0;
	const m = createModalController();
	m.setOnCancel(() => calls++);
	m.dismiss();
	m.dismiss();
	assert.equal(calls, 1);
});

test("commit clears the cancel handler so later teardown is a no-op", () => {
	let calls = 0;
	const m = createModalController();
	m.setOnCancel(() => calls++);
	m.commit();
	m.dismiss();
	assert.equal(calls, 0);
	assert.equal(m.hasCancel(), false);
});

test("setOnCancel(null) clears any registered handler", () => {
	let calls = 0;
	const m = createModalController();
	m.setOnCancel(() => calls++);
	m.setOnCancel(null);
	m.dismiss();
	assert.equal(calls, 0);
});

test("setOnCancel replaces the previous handler", () => {
	const events = [];
	const m = createModalController();
	m.setOnCancel(() => events.push("first"));
	m.setOnCancel(() => events.push("second"));
	m.dismiss();
	assert.deepEqual(events, ["second"]);
});
