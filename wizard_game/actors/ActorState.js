
export const ActorType = Object.freeze({ PLAYER: 0, NPC: 1 });
export const MovementState = Object.freeze({ IDLE: 0, WALKING: 1, BLOCKED: 2 });

export const AnimationId = Object.freeze({
    IDLE: 0, WALKING: 1, RUNNING: 2, UNSTEADY_WALK: 3, DEAD: 4, SKILL: 5,
    ATTACK_LIGHT: 6, ATTACK_HEAVY: 7, EXHAUSTED: 8, FALLING: 9,
    FREE_FALLING: 10, GETTING_UP: 11, HIT_FROM_FRONT_1: 12,
    HIT_FROM_FRONT_3: 13, HIT_FROM_SIDE: 14, LOOKING_TORCH: 15,
    PICKING_UP: 16, SITTING: 17, SLEEPING: 18, SPELL_CAST: 19,
    CROUCH_TORCH_WALK: 20, DRINKING: 21,
});

/**
 * Playback policy for an animation.
 *
 * LOCOMOTION   — managed automatically by _syncLocomotionAnimation.
 *                Never set via beginActionAnimation.
 *
 * INTERRUPTIBLE — one-shot action. Can be interrupted by another
 *                 beginActionAnimation call at any time.
 *
 * COMMITTED    — one-shot action that plays to completion before the
 *                next animation can start. Can still be interrupted by
 *                a TERMINAL animation.
 *
 * TERMINAL     — plays to completion and holds last frame forever.
 *                No further animations are possible (actor.isDown must
 *                be set true by the caller before or alongside this).
 *                Example: DEAD.
 */
export const AnimationPolicy = Object.freeze({
    LOCOMOTION:     0,
    INTERRUPTIBLE:  1,
    COMMITTED:      2,
    TERMINAL:       3,
});

/**
 * Default policy per animation ID.
 * Used by beginActionAnimation when no explicit policy is passed.
 */
export const DEFAULT_ANIMATION_POLICY = Object.freeze({
    [AnimationId.IDLE]:             AnimationPolicy.LOCOMOTION,
    [AnimationId.WALKING]:          AnimationPolicy.LOCOMOTION,
    [AnimationId.RUNNING]:          AnimationPolicy.LOCOMOTION,
    [AnimationId.UNSTEADY_WALK]:    AnimationPolicy.LOCOMOTION,

    [AnimationId.DEAD]:             AnimationPolicy.TERMINAL,

    [AnimationId.EXHAUSTED]:        AnimationPolicy.COMMITTED,
    [AnimationId.FALLING]:          AnimationPolicy.COMMITTED,
    [AnimationId.FREE_FALLING]:     AnimationPolicy.COMMITTED,
    [AnimationId.GETTING_UP]:       AnimationPolicy.COMMITTED,
    [AnimationId.PICKING_UP]:       AnimationPolicy.COMMITTED,
    [AnimationId.SPELL_CAST]:       AnimationPolicy.COMMITTED,
    [AnimationId.DRINKING]:         AnimationPolicy.COMMITTED,
    [AnimationId.SITTING]:          AnimationPolicy.COMMITTED,
    [AnimationId.SLEEPING]:         AnimationPolicy.COMMITTED,

    [AnimationId.SKILL]:            AnimationPolicy.INTERRUPTIBLE,
    [AnimationId.ATTACK_LIGHT]:     AnimationPolicy.INTERRUPTIBLE,
    [AnimationId.ATTACK_HEAVY]:     AnimationPolicy.INTERRUPTIBLE,
    [AnimationId.HIT_FROM_FRONT_1]: AnimationPolicy.INTERRUPTIBLE,
    [AnimationId.HIT_FROM_FRONT_3]: AnimationPolicy.INTERRUPTIBLE,
    [AnimationId.HIT_FROM_SIDE]:    AnimationPolicy.INTERRUPTIBLE,
    [AnimationId.LOOKING_TORCH]:    AnimationPolicy.LOCOMOTION,
    [AnimationId.CROUCH_TORCH_WALK]:AnimationPolicy.LOCOMOTION,
});

export const IntentFlags = Object.freeze({
    NONE: 0, MOVE_FORWARD: 1, MOVE_BACKWARD: 2,
    MOVE_LEFT: 4, MOVE_RIGHT: 8, MOVE_TO_TARGET: 16,
    // Edge-triggered impulse intents. Consumed by the GPU resolver and
    // cleared on the CPU each frame (writer is responsible).
    JUMP: 32,
});