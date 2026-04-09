// wizard_game studio entry point — wire WorldEditorView into the studio shell.
import { startStudio }      from '../tools/studio/Studio.js';
import { WorldEditorView }  from './WorldEditorView.js';

startStudio({ viewOverrides: { world: WorldEditorView } });
