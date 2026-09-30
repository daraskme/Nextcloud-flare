/** One permanently allocated system object, outside every user-object prefix. */
export const BINDING_PROBE_KEY = "system/r2-binding-probe-v1";
export const BINDING_PROBE_BYTES = 64;
export const BINDING_PROBE_KIND = "r2_binding_probe_v1";
export const isProbeNonce = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
