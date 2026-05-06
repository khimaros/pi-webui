// owns the commit-vs-cancel callback ordering for the picker modal.
//
// the ext_ui bridge installs a cancel handler so dismissals (Escape,
// backdrop click) reply to the server with a cancellation. without an
// explicit suppression step, the modal teardown that runs on commit also
// fires that handler, racing the cancel reply ahead of the real select
// value. the controller centralises ownership of the cancel callback so
// commits can clear it deterministically before teardown.

export function createModalController() {
	let onCancel = null;

	function setOnCancel(fn) {
		onCancel = fn ?? null;
	}

	// dismiss path (Esc, backdrop click): fire the registered handler once
	// and clear it. callers are responsible for any dom teardown.
	function dismiss() {
		const c = onCancel;
		onCancel = null;
		c?.();
	}

	// commit path: clear the cancel handler so subsequent teardown does
	// not invoke it. callers fire their own select callback after teardown.
	function commit() {
		onCancel = null;
	}

	function hasCancel() {
		return onCancel != null;
	}

	return { setOnCancel, dismiss, commit, hasCancel };
}
