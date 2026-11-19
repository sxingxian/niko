// The voice check's model, served from Niko's own site and pinned: a file whose fingerprint or size differs is refused.
// WeSpeaker ResNet34-LM trained on VoxCeleb (CC BY 4.0, https://github.com/wenet-e2e/wespeaker), as exported by
// sherpa-onnx (release "speaker-recongition-models", wespeaker_en_voxceleb_resnet34_LM.onnx, SHA-256 e9848563…9012).
// Niko's copy keeps the weights at half size (float16, turned back to float32 as it runs), which scores the same voices
// alike to six decimal places. 256 numbers per phrase.
export const VOICE_MODEL_URL = `${(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/app/"}models/voice-check-v1.onnx`;
export const VOICE_MODEL_SHA256 = 'c8a7ba358110d42553b2fb19aea43c89dd93d3c1c55c4018805c5c0b38d3dd92';
export const VOICE_MODEL_BYTES = 13_273_871;
export const VOICE_MODEL_CREDIT = 'Voice check: WeSpeaker ResNet34 (VoxCeleb), CC BY 4.0';
