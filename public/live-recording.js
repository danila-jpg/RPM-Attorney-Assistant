export const maxSeconds = 30;
export const maxRecordedBytes = 2 * 1024 * 1024;

// Decode the browser's container locally so the API only accepts bounded, canonical PCM.
export async function recordingToWav(blob) {
  const sampleRate = 16000;
  const decoder = new OfflineAudioContext(1, 1, sampleRate);
  const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
  const frames = Math.min(audio.length, maxSeconds * sampleRate);
  if (!frames) throw new Error("Запись пуста. Попробуйте ещё раз.");
  const wav = new ArrayBuffer(44 + frames * 2);
  const header = new DataView(wav);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVEfmt "], [36, "data"]]) {
    for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
  }
  for (const [offset, value] of [[4, wav.byteLength - 8], [16, 16], [24, sampleRate], [28, sampleRate * 2], [40, frames * 2]]) {
    header.setUint32(offset, value, true);
  }
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) header.setUint16(offset, value, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  for (let i = 0; i < frames; i++) {
    const sample = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
    header.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }
  return wav;
}
