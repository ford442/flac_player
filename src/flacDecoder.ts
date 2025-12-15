// FLAC decoder interface using Web Audio API
export interface FlacDecoderResult {
  sampleRate: number;
  channels: number;
  samples: Float32Array[];
  duration: number;
}

export class FlacDecoder {
  private audioContext: AudioContext;

  constructor() {
    this.audioContext = new AudioContext();
  }

  async decode(arrayBuffer: ArrayBuffer): Promise<FlacDecoderResult> {
    try {
      // Use Web Audio API to decode FLAC
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      
      const samples: Float32Array[] = [];
      for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
        samples.push(audioBuffer.getChannelData(i));
      }

      return {
        sampleRate: audioBuffer.sampleRate,
        channels: audioBuffer.numberOfChannels,
        samples,
        duration: audioBuffer.duration
      };
    } catch (error) {
      console.error('Error decoding FLAC:', error);
      throw new Error('Failed to decode FLAC file');
    }
  }

  async createAudioBuffer(decodedData: FlacDecoderResult): Promise<AudioBuffer> {
    const audioBuffer = this.audioContext.createBuffer(
      decodedData.channels,
      decodedData.samples[0].length,
      decodedData.sampleRate
    );

    for (let i = 0; i < decodedData.channels; i++) {
      const channelData = audioBuffer.getChannelData(i);
      channelData.set(decodedData.samples[i]);
    }

    return audioBuffer;
  }

  getAudioContext(): AudioContext {
    return this.audioContext;
  }
}
