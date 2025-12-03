// WindowedIconLayer: extends IconLayer to apply per-layer windowing (min/max)
// on the sampled texture intensity in the fragment shader, without reloading images.
import { IconLayer } from '@deck.gl/layers';

const DEFAULT_MIN = 0.0; // normalized
const DEFAULT_MAX = 1.0; // normalized

export default class WindowedIconLayer extends IconLayer {
  getUniforms() {
    const uniforms = super.getUniforms();
    uniforms.windowMin = this.props.windowMin || DEFAULT_MIN;
    uniforms.windowMax = this.props.windowMax || DEFAULT_MAX;
    uniforms.flatColor = this.props.flatColor ? 1.0 : 0.0;
    return uniforms;
  }
  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      inject: {
        // Declare uniforms for windowing range
        'fs:#decl': `
uniform float windowMin;
uniform float windowMax;
uniform float flatColor;
`,
        // Apply color and intensity before final output
        'fs:DECKGL_FILTER_COLOR': `
// Use stored intensity (in alpha) for windowing and brightness
float t = color.a;
// Optionally ignore texture intensity to render flat solid color
if (flatColor < 0.5) {
  // Windowing: map [windowMin, windowMax] → [0,1]; clamp outside and scale linearly inside.
  if (t <= windowMin) {
    t = 0.0;
  } else if (t >= windowMax) {
    t = 1.0;
  } else {
    float span = max(windowMax - windowMin, 1e-6);
    t = (t - windowMin) / span;
  }
} else {
  t = 1.0;
}
// Brightness: use windowed t to scale RGB (higher intensity → brighter)
color.rgb *= t;
// Alpha: fixed at 1.0; let blending do pure color addition (similar to preview plus‑lighter)
color.a = 1.0;
`,
      }
    };
  }
  updateState({props, oldProps, changeFlags}) {
    super.updateState({props, oldProps, changeFlags});
    const {model} = this.state;
    if (model) {
      model.setUniforms({
        windowMin: props.windowMin ?? DEFAULT_MIN,
        windowMax: props.windowMax ?? DEFAULT_MAX,
        flatColor: props.flatColor ? 1.0 : 0.0,
      });
    }
  }

  draw(opts) {
    const { uniforms = {} } = opts;
    const { windowMin = DEFAULT_MIN, windowMax = DEFAULT_MAX, flatColor = false } = this.props;

    super.draw({
      ...opts,
      uniforms: {
        ...uniforms,
        windowMin,
        windowMax,
        flatColor: flatColor ? 1.0 : 0.0,
      }
    });
  }
}
