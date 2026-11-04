declare const request: { url: string };
declare const suffix: string;

const path = request.url;

export const extended = path.concat(suffix);
