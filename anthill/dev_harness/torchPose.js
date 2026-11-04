// Match the torch mesh in MineCharacterView, in the character's local heading frame.
export const TORCH_OFFSET = [0.45, 1.62, -0.24];
export function carriedTorchPosition(character) {
    const [x, y, z] = TORCH_OFFSET;
    const c = Math.cos(character.heading), s = Math.sin(character.heading);
    return { x: character.position.x + c * x - s * z,
        y: character.position.y + y + Math.sin(character.phase) * 0.025,
        z: character.position.z + s * x + c * z };
}
