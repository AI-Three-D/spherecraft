// platform_game studio entry — Turn 1.
//
// For Turn 1 we reuse wizard_game's WorldEditorView. The view fetches
// ./world/{terrain,planet,engine,postprocessing}.json relative to the
// hosting HTML, so with this entry served from platform_game/studio.html
// it picks up platform_game/world/*.json automatically.
//
// In Turn 5 we'll fork this into a platform_game-specific view that
// understands level descriptions, cloud platforms, and pickup layouts.

import { startStudio }     from '../tools/studio/Studio.js';
import { WorldEditorView } from '../wizard_game/WorldEditorView.js';

startStudio({ viewOverrides: { world: WorldEditorView } });
