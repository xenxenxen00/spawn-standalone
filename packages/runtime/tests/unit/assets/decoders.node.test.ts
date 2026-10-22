import { describe, expect, it, vi } from 'vitest';
import { configureDecoders, loadMeshoptDecoder, vendorUrls, type VendorUrls } from '../../../src/assets/decoders.ts';
const vendor: VendorUrls = { meshoptDecoder: 'assets/decoder.js', ktx2: { transcoderPath: 'assets/basis/', jsTranscoder: 'assets/basis/transcoder.js', wasmTranscoder: 'assets/basis/transcoder.wasm' } };

describe('host-provided decoder URLs', () => {
  it('resolves only the supplied table against the supplied page URL', () => {
    const urls = vendorUrls('https://example.test/custom/index.html', vendor);
    expect(urls.meshoptDecoder).toBe('https://example.test/custom/assets/decoder.js');
    expect(urls.ktx2.transcoderPath).toBe('https://example.test/custom/assets/basis/');
    expect(() => vendorUrls('https://example.test/', { ...vendor, ktx2: { ...vendor.ktx2, transcoderPath: 'not-a-directory' } })).toThrow('directory');
  });

  it('configures both loaders with the supplied URLs and waits for decoder readiness', async () => {
    const setTranscoderPath = vi.fn(), setMeshoptDecoder = vi.fn(); const decoder = { ready: Promise.resolve(), supported: true }; const importer = vi.fn(async () => ({ MeshoptDecoder: decoder }));
    const urls = await configureDecoders(vendor, { ktx2: { setTranscoderPath }, gltf: { setMeshoptDecoder } }, { base: 'https://example.test/game/', importer });
    expect(setTranscoderPath).toHaveBeenCalledWith(urls.ktx2.transcoderPath);
    expect(importer).toHaveBeenCalledWith(urls.meshoptDecoder); expect(setMeshoptDecoder).toHaveBeenCalledWith(decoder);
  });

  it('does not cache a failed decoder import permanently', async () => {
    const importer = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ MeshoptDecoder: { ready: Promise.resolve(), supported: true } });
    await expect(loadMeshoptDecoder('https://example.test/retry.js', importer)).rejects.toThrow('offline');
    await expect(loadMeshoptDecoder('https://example.test/retry.js', importer)).resolves.toMatchObject({ supported: true });
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
