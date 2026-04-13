// Window uniforms for WindowedIconLayer (deck v9)
const uniformBlock = `\
uniform windowUniforms {
  float windowMin;
  float windowMax;
  float flatColor;
} window;
`;
export const windowUniforms = {
  name: 'window',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    windowMin: 'f32',
    windowMax: 'f32',
    flatColor: 'f32',
  },
};
