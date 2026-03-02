'use strict';

/**
 * Noise Gate AudioWorkletProcessor
 * Cuts signal below threshold with separate attack/release and open/close ratio.
 * ratio controls how aggressively the gate closes (higher = harder cut).
 */
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -40, minValue: -80, maxValue: 0,   automationRate: 'k-rate' },
      { name: 'ratio',     defaultValue: 10,  minValue: 1,   maxValue: 20,  automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 0.003, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 0.1,   minValue: 0.0001, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._envelope = 0;
    this._gainSmooth = 0;
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const threshold = parameters.threshold[0];
    const ratio     = parameters.ratio[0];
    const attack    = parameters.attack[0];
    const release   = parameters.release[0];

    const attackCoeff  = Math.exp(-1 / (sampleRate * attack));
    const releaseCoeff = Math.exp(-1 / (sampleRate * release));
    const threshLin    = Math.pow(10, threshold / 20);

    const numChannels = Math.min(input.length, output.length);

    for (let i = 0; i < (input[0]?.length || 0); i++) {
      let peak = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        peak = Math.max(peak, Math.abs(input[ch][i]));
      }

      // Envelope follower
      if (peak > this._envelope) {
        this._envelope = attackCoeff  * this._envelope + (1 - attackCoeff)  * peak;
      } else {
        this._envelope = releaseCoeff * this._envelope + (1 - releaseCoeff) * peak;
      }

      // Gate open/close: above threshold → gain 1, below → gain drops by ratio
      let desiredGain;
      if (this._envelope >= threshLin) {
        desiredGain = 1;
      } else if (this._envelope < 1e-10) {
        desiredGain = 0;
      } else {
        const envDb = 20 * Math.log10(this._envelope);
        // Below threshold: apply ratio-based attenuation
        const attenuationDb = (threshold - envDb) * (1 - 1 / ratio);
        desiredGain = Math.pow(10, -attenuationDb / 20);
        desiredGain = Math.max(0, Math.min(1, desiredGain));
      }

      // Smooth gain transitions (separate attack/release via envelope already handles timing)
      this._gainSmooth = 0.99 * this._gainSmooth + 0.01 * desiredGain;

      for (let ch = 0; ch < numChannels; ch++) {
        output[ch][i] = input[ch][i] * this._gainSmooth;
      }
    }

    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);
