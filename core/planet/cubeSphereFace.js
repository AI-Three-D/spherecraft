// js/planet/CubeSphereFace.js
export const CubeSphereFace = {
    POSITIVE_X: 0,
    NEGATIVE_X: 1,
    POSITIVE_Y: 2,
    NEGATIVE_Y: 3,
    POSITIVE_Z: 4,
    NEGATIVE_Z: 5
};

export const CubeSphereFaceNames = [
    'POSITIVE_X',
    'NEGATIVE_X', 
    'POSITIVE_Y',
    'NEGATIVE_Y',
    'POSITIVE_Z',
    'NEGATIVE_Z'
];

export function getFaceName(face) {
    return CubeSphereFaceNames[face] || 'UNKNOWN';
}

export function getFaceNormal(face) {
    const normals = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1]
    ];
    return normals[face];
}

export function getFaceUp(face) {
    const ups = [
        [0, 1, 0],
        [0, 1, 0],
        [0, 0, -1],
        [0, 0, 1],
        [0, 1, 0],
        [0, 1, 0]
    ];
    return ups[face];
}

export function getFaceRight(face) {
    const rights = [
        [0, 0, -1],
        [0, 0, 1],
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
        [-1, 0, 0]
    ];
    return rights[face];
}