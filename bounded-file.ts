import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedFile(path: string, maxBytes: number): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid file size");
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > maxBytes) throw new Error("Invalid file size");
		return buffer.subarray(0, length);
	} finally { closeSync(fd); }
}
