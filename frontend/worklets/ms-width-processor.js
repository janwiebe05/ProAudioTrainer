'use strict';

/**
 * Mid/Side Width Processor
 * width=0   → pure mono (M only, S=0)
 * width=100 → original stereo (M+S unchanged)
 * width=200 → doubled stereo width (S×2)
 *
 * M/S matrix:
 *   M = (L + R) / 2
 *   S = (L - R) / 2
 *   L_out = M + S * widthFactor
 *   R_out = M - S * widthFactor
 */
class MSWidthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'width', defaultValue: 100, minValue: 0, maxValue: 200, automationRate: 'k-rate' }];
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const widthFactor = parameters.width[0] / 100; // 0..2
    const L = input[0];
    const R = input[1] ?? input[0]; // fall back to mono if only one channel

    for (let i = 0; i < L.length; i++) {
      const m = (L[i] + R[i]) * 0.5;
      const s = (L[i] - R[i]) * 0.5;
      output[0][i] = m + s * widthFactor;
      if (output[1]) output[1][i] = m - s * widthFactor;
    }
    return true;
  }
}

registerProcessor('ms-width-processor', MSWidthProcessor);
