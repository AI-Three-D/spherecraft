// js/actors/ActorState.js

export const ActorType = Object.freeze({
    PLAYER: 0,
    NPC: 1,
});

export const MovementState = Object.freeze({
    IDLE: 0,
    WALKING: 1,
    BLOCKED: 2,
});

export const AnimationId = Object.freeze({
    IDLE: 0,
    WALKING: 1,
    RUNNING: 2,
    UNSTEADY_WALK: 3,
    DEAD: 4,
    SKILL: 5,
    ATTACK_LIGHT: 6,
    ATTACK_HEAVY: 7,
    EXHAUSTED: 8,
    FALLING: 9,
    FREE_FALLING: 10,
    GETTING_UP: 11,
    HIT_FROM_FRONT_1: 12,
    HIT_FROM_FRONT_3: 13,
    HIT_FROM_SIDE: 14,
    LOOKING_TORCH: 15,
    PICKING_UP: 16,
    SITTING: 17,
    SLEEPING: 18,
    SPELL_CAST: 19,
    CROUCH_TORCH_WALK: 20,
    DRINKING: 21,
});

export const IntentFlags = Object.freeze({
    NONE: 0,
    MOVE_FORWARD: 1,
    MOVE_BACKWARD: 2,
    MOVE_LEFT: 4,
    MOVE_RIGHT: 8,
    MOVE_TO_TARGET: 16,
});

export const ANIMATION_CLIP_NOTES = Object.freeze([
    { name: 'Walking', description: 'Standard locomotion walk.', mappedId: AnimationId.WALKING, active: true },
    { name: 'Attacking', description: 'Generic attack animation.', mappedId: AnimationId.SKILL, active: true },
    { name: 'Crouch_torch_1', description: 'Walking crouched while carrying a torch.', mappedId: AnimationId.CROUCH_TORCH_WALK, active: true },
    { name: 'Drinking', description: 'Sitting on an object such as a chair or log and drinking.', mappedId: AnimationId.DRINKING, active: true },
    { name: 'Dying', description: 'Death animation.', mappedId: AnimationId.DEAD, active: true },
    { name: 'Exhausted', description: 'Catching breath after running for a long time.', mappedId: AnimationId.EXHAUSTED, active: true },
    { name: 'Falling', description: 'Falling down from a standing position.', mappedId: AnimationId.FALLING, active: true },
    { name: 'Free_falling', description: 'Falling from a high place feet first.', mappedId: AnimationId.FREE_FALLING, active: true },
    { name: 'Getting_up', description: 'Getting up from the ground.', mappedId: AnimationId.GETTING_UP, active: true },
    { name: 'Hit_from_front1', description: 'Hurt reaction from the front.', mappedId: AnimationId.HIT_FROM_FRONT_1, active: true },
    { name: 'Hit_from_front3', description: 'Alternate hurt reaction from the front.', mappedId: AnimationId.HIT_FROM_FRONT_3, active: true },
    { name: 'Hit_from_side', description: 'Hurt reaction from the side.', mappedId: AnimationId.HIT_FROM_SIDE, active: true },
    { name: 'Idling', description: 'Idle animation with occasional side-to-side looks.', mappedId: AnimationId.IDLE, active: true },
    { name: 'Looking_torch', description: 'Idle animation while holding a torch.', mappedId: AnimationId.LOOKING_TORCH, active: true },
    { name: 'Picking_up', description: 'Picking an item up from the ground and pocketing it.', mappedId: AnimationId.PICKING_UP, active: true },
    { name: 'Running', description: 'Standard locomotion run.', mappedId: AnimationId.RUNNING, active: true },
    { name: 'Sitting', description: 'Sitting on the ground with legs crossed.', mappedId: AnimationId.SITTING, active: true },
    { name: 'Sleeping', description: 'Sleeping animation.', mappedId: AnimationId.SLEEPING, active: true },
    { name: 'Spell1', description: 'Attack animation for spell casting.', mappedId: AnimationId.SPELL_CAST, active: true },
    { name: 'Tired_walk', description: 'Wobbly tired or hurt walk.', mappedId: AnimationId.UNSTEADY_WALK, active: true },
]);

// Ordered patterns — earlier entries win so "unsteady" matches before "walk".
export const ANIMATION_NAME_PATTERNS = Object.freeze([
    { id: AnimationId.ATTACK_HEAVY, re: /Power_attack/i },
    { id: AnimationId.ATTACK_LIGHT, re: /Punching/i },
    { id: AnimationId.EXHAUSTED, re: /Exhausted/i },
    { id: AnimationId.FREE_FALLING, re: /Free_falling/i },
    { id: AnimationId.FALLING, re: /Falling/i },
    { id: AnimationId.GETTING_UP, re: /Getting_up/i },
    { id: AnimationId.HIT_FROM_FRONT_1, re: /Hit_from_front1/i },
    { id: AnimationId.HIT_FROM_FRONT_3, re: /Hit_from_front3/i },
    { id: AnimationId.HIT_FROM_SIDE, re: /Hit_from_side/i },
    { id: AnimationId.LOOKING_TORCH, re: /Looking_torch/i },
    { id: AnimationId.PICKING_UP, re: /Picking_up/i },
    { id: AnimationId.SITTING, re: /Sitting/i },
    { id: AnimationId.SLEEPING, re: /Sleeping/i },
    { id: AnimationId.SPELL_CAST, re: /Spell1/i },
    { id: AnimationId.CROUCH_TORCH_WALK, re: /Crouch_torch_1/i },
    { id: AnimationId.DRINKING, re: /Drinking/i },
    { id: AnimationId.UNSTEADY_WALK, re: /Weak|Tired_walk/i },
    { id: AnimationId.WALKING, re: /Walking/i },
    { id: AnimationId.RUNNING, re: /Running/i },
    { id: AnimationId.IDLE, re: /Idling/i },
    { id: AnimationId.DEAD, re: /Dying|Dead|Slumping/i },
    { id: AnimationId.SKILL, re: /Attacking/i },
]);
