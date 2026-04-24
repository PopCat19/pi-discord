/**
 * Builds a no-op extension UI context for headless bot sessions.
 */
export function createHeadlessUi() {
	const noop = () => undefined;
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => undefined,
		onTerminalInput: () => noop,
		setStatus: () => undefined,
		setWorkingMessage: () => undefined,
		setWidget: () => undefined,
		setFooter: () => undefined,
		setHeader: () => undefined,
		setTitle: () => undefined,
		custom: async () => undefined,
		pasteToEditor: () => undefined,
		setEditorText: () => undefined,
		getEditorText: () => "",
		editor: async () => undefined,
		setEditorComponent: () => undefined,
	};
}
