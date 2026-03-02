'use strict';

/**
 * Downward Expander AudioWorkletProcessor
 * Reduces gain for signals below the threshold — the opposite of a compressor.
 * Transfer function:
 *   input >= threshold  →  output = input  (1:1 pass-through)
 *   input <  threshold  →  output dB = threshold + (input_dB - threshold) * ratio
 *                          (signals drop ratio× faster below threshold)
 */
class ExpanderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -30, minValue: -80, maxValue: 0,   automationRate: 'k-rate' },
      { name: 'ratio',     defaultValue: 2,   minValue: 1,   maxValue: 10,  automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 0.01, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 0.1,  minValue: 0.0001, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._envelope = 0;   // current RMS envelope (linear)
    this._gainSmooth = 1; // smoothed gain
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const threshold = parameters.threshold[0]; // dBFS
    const ratio     = parameters.ratio[0];
    const attack    = parameters.attack[0];    // seconds
    const release   = parameters.release[0];   // seconds

    const attackCoeff  = Math.exp(-1 / (sampleRate * attack));
    const releaseCoeff = Math.exp(-1 / (sampleRate * release));
    const threshLin    = Math.pow(10, threshold / 20);

    const numChannels = Math.min(input.length, output.length);

    for (let i = 0; i < (input[0]?.length || 0); i++) {
      // Peak detection across all channels
      let peak = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        peak = Math.max(peak, Math.abs(input[ch][i]));
      }

      // Envelope follower with separate attack / release
      if (peak > this._envelope) {
        this._envelope = attackCoeff  * this._envelope + (1 - attackCoeff)  * peak;
      } else {
        this._envelope = releaseCoeff * this._envelope + (1 - releaseCoeff) * peak;
      }

      // Gain computation
      let desiredGain = 1;
      if (this._envelope < threshLin && this._envelope > 1e-10) {
        const envDb  = 20 * Math.log10(this._envelope);
        const outDb  = threshold + (envDb - threshold) * ratio; // push further below threshold
        desiredGain  = Math.pow(10, (outDb - envDb) / 20);      // gain correction factor
        desiredGain  = Math.max(0, Math.min(1, desiredGain));
      }

      // Smooth the gain — use envelope coefficients so timing matches attack/release
      const coeff = desiredGain < this._gainSmooth ? attackCoeff : releaseCoeff;
      this._gainSmooth = coeff * this._gainSmooth + (1 - coeff) * desiredGain;

      // Apply to all channels
      for (let ch = 0; ch < numChannels; ch++) {
        output[ch][i] = input[ch][i] * this._gainSmooth;
      }
    }

    return true;
  }
}

registerProcessor('expander-processor', ExpanderProcessor);
