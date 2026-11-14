import { timingSafeEqual } from 'node:crypto';

// A bcrypt verifier for the password hashes a SLiMS installation stores (PHP's `password_hash`, `$2y$`, and the `$2a$`
// and `$2b$` forms of other bcrypt libraries), so that a member migrated with a SLiMS password can sign in once with
// it; the login then stores a scrypt hash in its place. Written from the published descriptions of Blowfish (Schneier,
// 1993) and of bcrypt's expensive key schedule (Provos and Mazières, 1999); it only verifies, it never makes a hash.
//
// - The hash is `$2<a|b|y>$<cost>$<22 characters of salt><31 characters of digest>` in bcrypt's own base64 alphabet
//   (`./A-Za-z0-9`). Only costs 4 to 12 are accepted: a higher cost would let one stored row stall the server (one
//   verification doubles with each step), and such a hash is not migrated (the member resets the password instead).
// - The key is the password's UTF-8 bytes with a terminating NUL, cut to 72 bytes (what every form above does; the
//   `$2a$` length bug of old OpenBSD releases only touches passwords over 255 bytes, which the cut makes equal). The
//   password is taken as typed, not normalised: PHP hashed the bytes the browser sent.
// - The Blowfish start state is the fractional part of pi in hexadecimal (18 subkeys, then four S-boxes of 256 words),
//   kept here as base64; test/bcrypt.test.ts derives the same digits from pi itself.
// - The work runs in slices that give the event loop back (setImmediate) so that a verification of cost 12 does not
//   hold up every other request; the comparison of the digest is constant-time.

/** The lowest and highest bcrypt cost verified (2^cost rounds of the key schedule). */
export const BCRYPT_MIN_COST = 4;
export const BCRYPT_MAX_COST = 12;

const BCRYPT_HASH = /^\$2[aby]\$(\d{2})\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/;

/** bcrypt's base64 alphabet. */
const ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** "OrpheanBeholderScryDoubt": the text bcrypt encrypts 64 times, as six big-endian words. */
const MAGIC = [0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274];

/** How many rounds of the expensive key schedule run before the event loop gets a turn. */
const ROUNDS_PER_SLICE = 32;

const PI_WORDS_B64 =
  'JD9qiIWjCNMTGYouA3BzRKQJOCIpnzHQCC76mOxObIlFKCHmONATd75UZs806QxswKwpt8l8UN0/hNW1tUcJF5IW1dmJefsb0TEL' +
  'ppjftawv/XLb0Brft7jhr+1qJn6WunyQRfEsf5kkoZlHs5Fs9wgB8uKFjvwWY2kg2HFXTmmkWP6j9JM9fg2VdI9yjrZYcYvNWIIV' +
  'Su57VKQdwlpZtZww1Tkq8mATxdGwIyhghfDKQXkYuNs474553LBgOhgObJ4Oi7Aeij7XFXfBvTFLJ3ivL9pVYFxg5lUl86pVq5RX' +
  'SJhiY+gUQFXKOWoqqxC2tMxcNBFB6M6hVIavfHLpk7PuFBFjb7wqK6nFXXQYMfbOXD4Wm4eTHq/WujNsJM9cejJTgSiVhnc7j0iY' +
  'a0u5r8S/6BtmKCGTYdgJzPshqZFIfKxgXeyAMu+EXV3phXWx3CYjAutlG4gjiT6B05asxQ9tb/OD9EI5LgtEgqSEIARpyPBKnh+b' +
  'XiHGaEL26WyaZwycYavTiPBqUaDS2FQvaJYPpyirUTOjbu8LbBN6O+S6O/BQfvsqmKHxZR05rwF2ZspZPoJDDoiM7oYZRW+ftH2E' +
  'pcM7i16+4G912IXBIHNAGkSfVsFqpk7TqmI2P3cGG/7fckKbAj030Nck0AoSSNsP6tNJ8cCbB1NyyYCZG3sl1HnY9uje9+P+UBq2' +
  'eUw7l2zgvQTABrrBqU+2QJ9gxF5cnsIZaiRjaPtvrz5sU7UTObLrO1Lsb238UR+bMJUszIFFRK9evQm+49AE3jNK/WYPKAcZLkuz' +
  'wMuoV0XIdA/SC185udP721V5wL0aYDIK1qEAxkAscnlnnyX++x+jzI6l6fjbMiL4PHUW3/1haxUvUB7IrQVSqzI9tfr9I4dgUzF7' +
  'SD4A34KeXFe7ym+MoBqHVi7fF2nb1UKo9ih+/8OsZzLGjE9Vc2lbJ7C7yljI4f+jXbjwEaAQ+j2Y/SGDuEr8tWwt0dNbmlPkebb4' +
  'RWXSjkm8S/uXkOHd8tqky34zYvsTQc7kxujvIMraNndMAdB+nv4r8R+0ldvaTa6QkZjqrY5xa5PVoNCO0dCvxyXgjjxbL451lLeP' +
  '9uL78hIrZIiIuBKQDfAcT61eoGiPwxzRz/GRs6jBrS8vIhi+Dhd36nUt/osCH6HloMwPtW906Bis89bOieKZtKhP4P0T4Ld8xDuB' +
  '0q2o2RZfomaAlXcFk8xzFCEaFHfmrSBld7X6hsdUQvX7nTXP682vDHs+iaDWQRvTrh5+SQAlDi0gcbNeImgAu1e44K8kZDab8Am5' +
  'HlVjkR1Z36aqeMFDidlaU38gfVuiAuW5xYMmA3Zilc+pEcgZaE5zSkGzRy3KexSpShtRAFKaUykV1g9XP7ybxuQrYKR2geZ0AAi6' +
  'b7VXG+kf8pbsayoN2RW2Y2Uh57n5tv80BS7FhVZkU7AtXamfj6EIukeZboUHakt6cOm1sylE23UJLsQZJiOtbqawSafffZzuYLiP' +
  '7bJm7KqMcWmaF/9WZFJswrGe4Rk2AqV1CUwpoFkTQOQYOj4/VJiaW0KdZWuP5NaZ9z/WodKcB+/oMPVNLTjm8CVdwUzdIIaEcOsm' +
  'Y4LpxgIezF4JaGs/PrrvyTyXGBRranChaH81hFKg4oa3nFMFqlAHNz4HhBx/3q5cjn1E7FcW8riwOto38FAMDfAcHwQCALP/rgz1' +
  'Gjy1dLIlg3pY3AkhvdGRE/l8qS/2lDJHcyL1RwE65eWBN8La3Mi1djSa892nqURhRg/QAw7syMc+pHUeQeI4zZk76g4vMoC7oRg+' +
  'szFOVIs4T225CG9CDQP2CgS/LLgSkCSXfHlWebByvK+Jr96adx/ZkwgQs4uuEtzPPy5VEnIfLmtxJFAa3eafhM2HelhHGHQI2he8' +
  'n5q86Ut9jOx67DrbhR36YwlDZsRkw9LvHBhHMhXZCN1DOzckwroWEqFNQyplxFFQlAACEzrk3XHf+J4QMU5Vgax31l8RGZsENVbx' +
  '16PHazwRGDtZJKUJ8o/m7Zfx+/qeur8sHhU8bobjRXDq6W+xhg5eClo+KrN3H+ccTj0G+ill3LmZ5x0PgD6J1lJmyCUuTMl4nBCz' +
  'asYVDrqU4up4pfw8Ux4KLfTy906nNh0rPRk5Jg8ZwnlgUiOnCPcTErbrrf5u6sMfZuO8RZWme8iDsX830QGM/yjDMt3vvmxapWVY' +
  'IYVoq5gC7s6lD9svlTsq732tW24vhBUhtigpB2Fw7N1HdWGfFRATzKgw62G9lgM0/h6qA2PPtXNckExwojnVnp4Ly6reFO7Mhrxg' +
  'YiynnKtcq7LzhG5kix6vGb3wyqAjabllWrtQQGhaMjwqtLMxnunVwCG495tUCxmHX6CZlfeZfmI9faj4N4ial+MtdxHtk18WaBKB' +
  'DjWIKcfmH9aW3t+heFi6mVf1hKUbInJjm4PD/xrCRpbNswrrUy4wVI/ZSORtvDEoWOvy7zTG/+r+KO1h7nw8c11KFNnoZLfjQhBd' +
  'FCA+E+BF7uK2o6qr6ttsTxX6y0/Qx0L0Qu9qu7VlTzsdQc0hBdgeeZ6GhU3H5EtHaj2BYlDPYqHyW40mRvyIg6DBx7ajfxUkw2nL' +
  'dJJHhIoLVpKyhQlbvwCtGUidFGKxdCOCDgBYQo0qDFX16h2t9D4jP3BhM3Lwko2TfkHWX+zxbCI723zeN1nL7nRgQIXyp853Mm6m' +
  'B4CEGfhQnujv2FVh2Zc1qWmnqsUMBsJaBKv8gAvK3J5Eei7DRTSE/dVnBQ4ensnbc9vTEFWIzWdf2nnjZ0NAxcQ0ZXE+ONg9KPie' +
  '8W3/IBU+IeePsD1K5uOfK9uDrffpPVpolIFA9/ZMJhyUaSk0QRUg93YC1Pe89Gsu1KIAaNQIJHEzIPRqQ7fUt1AAYa8eOfYulyRF' +
  'RhQhT3S/i4hATZX8HZa1ka9w9N3TZqAvRb+8CewDvZeFf6xt0DHLhQSW6yezVf05QdolR+arygqaKFB4JVMEKfQKLIba6bZt+2jc' +
  'FGLXSGkAaA7ApCehje5PP/6i6IetjLWM4AZ69Na2qs4efNM3X+zOeKOZQGsqQiD+njXZ84W57jnXqzsSTosdyfr3S20YViajZjHq' +
  '45eyOm76dN1bQzJoQef3yngg+/sK9U7Y/rOXRUBWrLpIlSdVUzo6IIONh/5rqbfQlpVLVahnvKEVmljMqSljmeHbM6YqSlY/MSX5' +
  'XvR+HJApMXz9+OgCBCcvcIC7FVwFKCzjlcEVSOTGbSJIwRM/xw+G3Af5ye5BBB8PQEd5pF2IbhcyX1Hr1ZvA0fK8wY9BETVkJXt4' +
  'NGAqnGDf+OijH2NsGw4StMIC4TKer2ZP0crRgRVrI5XgMz6S4TskC2LuvrkihbKiDua6DZnecgyMLaL3KNASeEWVt5T9ZH0IYufM' +
  '9fBUSaNvh31I+sOd/SfzPo0eCkdjQZku/3Q6b26r9Pj9N6gS3GCh6934mRvhTNtuaw3Ge1UQbWcsNydl1Dvc0OgE8SkNx8wA/6O1' +
  'OQ+SaQ/tC2Z7n/vO232coJHPC9kVXqO7Ey+IUVutJHuUeb92O9brNzkus8wRWXmAJuKX9C4xLWhCrafGais7EnVMzHgu8RxqEkI3' +
  't5JR5wahu+ZL+2NQGmsQGBHK7fo9Jb3Y4uHDyURCFlkKEhOG2QzsbtWr6ipkr2dO2oaoX76/6Yhk5MP+nbyAV/D3wIZgeHv4YANg' +
  'TdH9g0b2OB+wd0WuBNc2/MyDQmsz8B6rcbCAQYc8AF5fd6BXvr3oriRVRkKZv1guYU5Y9I/y3f2i9HTvOIeJvcJTZvnDyLOOdLR1' +
  '8lVG/Nm5eusmYYsd34SEag55kV+V4kZuWY4gtFdwjNVVkckC3ky5C6zhu4IF0BGoYkh1dKmet38ZtuCp3AlmLQmhxDJGM+haHwIJ' +
  '8L6MSpmgJR1u/hAauT0dC6Wk36GG8g8oaPFp3Lfag1c5Bv6h4s6bT81/UlARXgGnBoP6oAK1xA3m0Cea+Iwndz+GQcNgTAZhqAa1' +
  '8Bd6KMD1huAAYFiqMNx9YhHmntcjOOpjU8LdlMLCFjS7y+5WkLy23uv8faHOWR12bwXkCUt8AYg5cgo9fJJ8JIbjcl9yTZ25GsFb' +
  'tNOeuPztVFV4CPyltdg9fNNNrQ/EHlDvXrFh5viihRTZbFETPG/Vx+dW4U7ENiq/zt3GyDfXmjI0kmOCEmcO+o5AYADgOjnON9P6' +
  '9c+rwnc3WsUtG1ywZ55PozdC04InQJm8m77VEY6dvw9zFdYtHH7HAMR7t4wbayGhkEWybrG+ajZutFdIqy+8lG55xqN20mVJwshT' +
  'D/juRo3efdVzCh1M0E3GKTm726m6RlCslSbovl7jBKH61fBqLVGaY++M4pqG7iLAicK4QyQu9qUeA6qc8tCkg8Bhupvpak2P5RVQ' +
  'umRb1igmovmnOjrhS6mVhu9VYunHL+/T91L32j8Eb2l3+gpZgOSpFYewhgGbCeatOz7lk+mQ/VqeNNeXLPC32QIri1GW1aw6AX2m' +
  'fdHPPtZ8fS0oH58lz63yuJta1rRyWoj1TOAprHHgGaXmR7Cs/e2T+pvo08SNKDtXzPjVZil5Ey4oeF8Bke11YFX3lg5E49NejBUF' +
  'bdSI9G26A6FhJQVk8L3D654VPJBXopcnGuypOgcqGz9tmx5jIfX1nGb7JtzzGXUz2SixVf31A1Y0goq6PLsoUXcRwgrZ+KvMUWfM' +
  'rZJfTegXUTgw3I43nVhikyD5kep6kML7PnvOUSHOZHdPvjKotuN+wyk9RkjeU2lkE+aAoq4IEN1tsiRphS39CQchZrOaRgpkRcDd' +
  'WGzezxwgyK5bvvfdG1iNQMzSAX9rtOO73aJqfjpZ/0U+NQpEvLTN1XLqzqj6ZIS7jWYSrr88b0fSm+RjVC9dnq7Cdxv2TmNwdA4N' +
  'jedbE1f4chZxr1N9XUBAywhOtOLMNNJGagEVr4ThsAQolZg6HQa4n7TObqBIbz87gjUgq4IBGh1LJ3In+GEVYLHnkz/cuzp5KzRF' +
  'Jb2giDnhUc55Sy8yybegH7rJ4BzIfrzH0fbPARHDoeiqxxqQh0nUT72a0Nrey9UK2jgDOcMqxpE2Z435MXzgsStP955Zt0P1uzry' +
  '1Rn/J9lFnL+XIiwV5vwqD5H8cZuUFSX65ZNhzrac68KoZFkSuqjRtsEHXuMFagwQ0lBlywOkQuDsbg4WmNs7TJigvjJ46WSfH5Uy' +
  '4NOS39OgNCuJcfIeGwp0QUujNIzFvnEgw3Yy2N81n42bmS8u5gtvRw/j8R3lTNpUHtrYkc5iec/NPn5vFhixZv0sHQWEj9LF9vsi' +
  'mfUj81emMnYjk6g1MVbMzQKs8IFiWnXrtW4WNpeI0nPM3pZikoG5SdBMUJAbccZWFObGx70yehQKReHQBsPye5rJqlP9YqgPALsl' +
  'v+I1vdL2cRJpBbIEAiK2y898zXacK1MRPsAWQOPTOKu9YCVHrfC6OCCc90bOdnevocUgdWBghcv+Torojdh6qvmwTPmqfhlIwlwC' +
  '+4qMAcNq5Nbr4fmQ1PhpplzeoD8JJS3CCOaft05hMs534ltXj9/jOsNy5g==';

let start: Uint32Array | undefined;

/** The Blowfish start state: P[0..17] then S0..S3, 1042 words of pi's fractional hexadecimal digits. */
function startState(): Uint32Array {
  if (start === undefined) {
    const bytes = Buffer.from(PI_WORDS_B64, 'base64');
    const words = new Uint32Array(1042);
    for (let i = 0; i < words.length; i += 1) words[i] = bytes.readUInt32BE(i * 4);
    start = words;
  }
  return start;
}

/** Whether `hash` has the form of a bcrypt hash this verifier knows (`$2a$`, `$2b$`, `$2y$`), whatever its cost. */
export function isBcryptHash(hash: string): boolean {
  return typeof hash === 'string' && BCRYPT_HASH.test(hash);
}

/** The cost written in a bcrypt hash, or null when `hash` is not one. */
export function bcryptCost(hash: string): number | null {
  const m = typeof hash === 'string' ? BCRYPT_HASH.exec(hash) : null;
  return m === null ? null : Number(m[1]);
}

/** `count` bytes of bcrypt base64 `text`; null when a character is outside the alphabet. */
function decode64(text: string, count: number): Uint8Array | null {
  const out = new Uint8Array(count);
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (n < count) out[n++] = (acc >>> bits) & 0xff;
    }
  }
  return n === count ? out : null;
}

/** `bytes` in bcrypt base64, without padding (23 bytes → 31 characters). */
function encode64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const c1 = bytes[i++]!;
    out += ALPHABET[c1 >> 2];
    let c = (c1 & 0x03) << 4;
    if (i >= bytes.length) {
      out += ALPHABET[c];
      break;
    }
    const c2 = bytes[i++]!;
    out += ALPHABET[c | (c2 >> 4)];
    c = (c2 & 0x0f) << 2;
    if (i >= bytes.length) {
      out += ALPHABET[c];
      break;
    }
    const c3 = bytes[i++]!;
    out += ALPHABET[c | (c3 >> 6)];
    out += ALPHABET[c3 & 0x3f];
  }
  return out;
}

/** The Blowfish state of one verification: the subkeys and the four S-boxes in one array. */
class Blowfish {
  readonly s: Uint32Array;
  /** The block the last encipher left: [left, right]. */
  readonly lr = new Uint32Array(2);

  constructor() {
    this.s = Uint32Array.from(startState());
  }

  /** Enciphers `lr` in place (16 rounds). */
  encipher(): void {
    const s = this.s;
    let l = this.lr[0]!;
    let r = this.lr[1]!;
    l ^= s[0]!;
    for (let i = 1; i <= 16; i += 2) {
      r ^= (((s[18 + (l >>> 24)]! + s[274 + ((l >>> 16) & 0xff)]!) ^ s[530 + ((l >>> 8) & 0xff)]!) + s[786 + (l & 0xff)]!) ^ s[i]!;
      l ^= (((s[18 + (r >>> 24)]! + s[274 + ((r >>> 16) & 0xff)]!) ^ s[530 + ((r >>> 8) & 0xff)]!) + s[786 + (r & 0xff)]!) ^ s[i + 1]!;
    }
    this.lr[0] = r ^ s[17]!;
    this.lr[1] = l;
  }

  /**
   * The key schedule step of bcrypt: the subkeys XOR the key's words (taken cyclically), then every subkey and S-box
   * word is replaced by enciphering, the block XORed with the salt's words (cyclically) first when a salt is given.
   */
  expand(key: Uint8Array, salt: Uint8Array | null): void {
    const s = this.s;
    let kp = 0;
    for (let i = 0; i < 18; i += 1) {
      let word = 0;
      for (let k = 0; k < 4; k += 1) {
        word = ((word << 8) | key[kp]!) >>> 0;
        kp = (kp + 1) % key.length;
      }
      s[i] = (s[i]! ^ word) >>> 0;
    }
    let sp = 0;
    const saltWord = (): number => {
      let word = 0;
      for (let k = 0; k < 4; k += 1) {
        word = ((word << 8) | salt![sp]!) >>> 0;
        sp = (sp + 1) % salt!.length;
      }
      return word;
    };
    this.lr[0] = 0;
    this.lr[1] = 0;
    for (let i = 0; i < 1042; i += 2) {
      if (salt !== null) {
        this.lr[0] = this.lr[0]! ^ saltWord();
        this.lr[1] = this.lr[1]! ^ saltWord();
      }
      this.encipher();
      s[i] = this.lr[0]!;
      s[i + 1] = this.lr[1]!;
    }
  }
}

/** Gives the event loop a turn. */
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The 23-byte digest bcrypt computes for `key` (already NUL-terminated and cut), `salt` (16 bytes) and `cost`. */
async function digest(key: Uint8Array, salt: Uint8Array, cost: number): Promise<Uint8Array> {
  const bf = new Blowfish();
  bf.expand(key, salt);
  const rounds = 2 ** cost;
  for (let i = 0; i < rounds; i += 1) {
    bf.expand(key, null);
    bf.expand(salt, null);
    if ((i + 1) % ROUNDS_PER_SLICE === 0 && i + 1 < rounds) await yieldTurn();
  }
  const text = Uint32Array.from(MAGIC);
  for (let i = 0; i < 6; i += 2) {
    bf.lr[0] = text[i]!;
    bf.lr[1] = text[i + 1]!;
    for (let k = 0; k < 64; k += 1) bf.encipher();
    text[i] = bf.lr[0]!;
    text[i + 1] = bf.lr[1]!;
  }
  const out = new Uint8Array(24);
  for (let i = 0; i < 6; i += 1) {
    out[i * 4] = text[i]! >>> 24;
    out[i * 4 + 1] = (text[i]! >>> 16) & 0xff;
    out[i * 4 + 2] = (text[i]! >>> 8) & 0xff;
    out[i * 4 + 3] = text[i]! & 0xff;
  }
  return out.subarray(0, 23);
}

/** The bcrypt key of `password`: its bytes (UTF-8 for a string) and a NUL, at most 72 bytes. */
function keyOf(password: string | Uint8Array): Uint8Array {
  const bytes = typeof password === 'string' ? Buffer.from(password, 'utf8') : password;
  const key = new Uint8Array(Math.min(bytes.length + 1, 72));
  key.set(bytes.subarray(0, key.length));
  if (bytes.length < 72) key[bytes.length] = 0;
  return key;
}

/**
 * Whether `password` (a string, as UTF-8, or raw bytes) is the password of the bcrypt `hash`. False for anything that
 * is not a `$2a$`/`$2b$`/`$2y$` hash of cost 4-12 with a well-formed salt and digest; the digest is compared in
 * constant time.
 */
export async function bcryptVerify(password: string | Uint8Array, hash: string): Promise<boolean> {
  const m = typeof hash === 'string' ? BCRYPT_HASH.exec(hash) : null;
  if (m === null) return false;
  const cost = Number(m[1]);
  if (cost < BCRYPT_MIN_COST || cost > BCRYPT_MAX_COST) return false;
  const salt = decode64(m[2]!, 16);
  if (salt === null) return false;
  // A digest written with stray bits in its last character is not one bcrypt makes: compare the text it would be.
  const computed = encode64(await digest(keyOf(password), salt, cost));
  const expected = Buffer.from(m[3]!, 'latin1');
  const got = Buffer.from(computed, 'latin1');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
