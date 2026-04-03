export const shadowDepthVertex = `#version 300 es
precision highp float;

in vec3 position;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;

out float vDepth;

void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vec4 viewPosition = viewMatrix * worldPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;

    gl_Position = projectedPosition;
    vDepth = (projectedPosition.z / projectedPosition.w) * 0.5 + 0.5;
}
`;

export const shadowDepthInstancedVertex = `#version 300 es
precision highp float;

in vec3 position;
in mat4 instanceMatrix;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;

out float vDepth;

void main() {
    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec4 viewPosition = viewMatrix * worldPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;

    gl_Position = projectedPosition;
    vDepth = (projectedPosition.z / projectedPosition.w) * 0.5 + 0.5;
}
`;

export const shadowDepthFragment = `#version 300 es
precision highp float;

in float vDepth;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(vDepth, vDepth, vDepth, 1.0);
}
`;