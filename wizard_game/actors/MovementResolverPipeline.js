// Compatibility shim — the real implementation lives under core/actors/.
// Kept here so existing imports in wizard_game keep working. New code
// should import directly from core/actors/.
export { MovementResolverPipeline } from '../../core/actors/MovementResolverPipeline.js';
