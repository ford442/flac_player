import { useRef } from 'react';

export interface ShaderGUIUniforms {
  resolution: [number, number];
  time: number;
  beatPhase: number;
  rsycrb: number;
  fractal: number;
  pulse: number;
  audioLevel: number;
  audioLevelL: number;
  audioLevelR: number;
  spectrum0: number;
  spectrum1: number;
  spectrum2: number;
  spectrum3: number;
  spectrum4: number;
  modeNone: number;
  modeIR: number;
  isPlaying: number;
  playbackProgress: number;
  volume: number;
  colorShift: number;
}

export function useShaderUniforms() {
  const uniformsRef = useRef<ShaderGUIUniforms>({
    resolution: [1, 1],
    time: 0,
    beatPhase: 0,
    rsycrb: 0.0,
    fractal: 0.0,
    pulse: 0.0,
    audioLevel: 0,
    audioLevelL: 0,
    audioLevelR: 0,
    spectrum0: 0,
    spectrum1: 0,
    spectrum2: 0,
    spectrum3: 0,
    spectrum4: 0,
    modeNone: 1,
    modeIR: 0,
    isPlaying: 0,
    playbackProgress: 0,
    volume: 1,
    colorShift: 0,
  });

  const updateUniforms = useRef((partial: Partial<ShaderGUIUniforms>) => {
    uniformsRef.current = { ...uniformsRef.current, ...partial };
  });

  const writeBuffer = useRef((device: GPUDevice, buffer: GPUBuffer) => {
    const u = uniformsRef.current;
    device.queue.writeBuffer(
      buffer,
      0,
      new Float32Array([
        u.resolution[0], u.resolution[1],
        u.time,
        u.beatPhase,
        u.rsycrb,
        u.fractal,
        u.pulse,
        u.audioLevel,
        u.audioLevelL,
        u.audioLevelR,
        u.spectrum0,
        u.spectrum1,
        u.spectrum2,
        u.spectrum3,
        u.spectrum4,
        u.modeNone,
        u.modeIR,
        u.isPlaying,
        u.playbackProgress,
        u.volume,
        u.colorShift,
      ])
    );
  });

  return {
    uniformsRef,
    updateUniforms: updateUniforms.current,
    writeBuffer: writeBuffer.current,
  };
}

export default useShaderUniforms;
