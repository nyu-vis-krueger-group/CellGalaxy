// IconLayer + intensity window in FS (windowUniforms, v9 shaderInputs).
import { IconLayer } from '@deck.gl/layers';
import { windowUniforms } from './windowUniforms';

const DEFAULT_MIN = 0.0; // normalized
const DEFAULT_MAX = 1.0; // normalized

export default class WindowedIconLayer extends IconLayer {
  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      modules: [...(shaders.modules || []), windowUniforms],
      inject: {
        'fs:DECKGL_FILTER_COLOR': `
float t = color.a;
if (window.flatColor < 0.5) {
  if (t <= window.windowMin) {
    t = 0.0;
  } else if (t >= window.windowMax) {
    t = 1.0;
  } else {
    float span = max(window.windowMax - window.windowMin, 1e-6);
    t = (t - window.windowMin) / span;
  }
} else {
  t = 1.0;
}
color.rgb *= t;
color.a = 1.0;
`,
      }
    };
  }

  draw(opts) {
    const model = this.state.model;
    if (model?.shaderInputs) {
      model.shaderInputs.setProps({
        window: {
          windowMin: this.props.windowMin ?? DEFAULT_MIN,
          windowMax: this.props.windowMax ?? DEFAULT_MAX,
          flatColor: this.props.flatColor ? 1.0 : 0.0,
        },
      });
    }
    super.draw(opts);
  }
}
