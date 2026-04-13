/**
 * WorldView — default world view for tools/studio/studio.html.
 *
 * Extends WorldViewBase but provides no engine. The full sidebar UI with all
 * parameter sliders is shown, but the viewport is empty. This is useful for
 * inspecting / editing world JSON configs without running the engine.
 *
 * For a live-rendering authoring view, subclass WorldAuthoringView.
 */

import { WorldViewBase } from './WorldViewBase.js';

export class WorldView extends WorldViewBase {
    // worldDir and configLoader are null by default → shows "no configLoader" message
    // Override these if you have JSON files accessible from the tools/studio/ context.
}
