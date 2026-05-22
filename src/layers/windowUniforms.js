// Window uniforms for WindowedIconLayer (deck v9) — matches hover intensityWindow.js
const uniformBlock = `\
uniform windowUniforms {
  float windowMin;
  float windowMax;
  float flatColor;
  float channelAlpha;
  float toneGain;
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
    channelAlpha: 'f32',
    toneGain: 'f32',
  },
};
