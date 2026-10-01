// YouTube request runtime: block ad breaks, negotiate keys, prefer maximum quality.
(() => {
    const CONFIG_KEY = "YouTubeConfig";
    const QUALITY_KEY = "YouTubeQuality";

    // 1. Surge dispatch. Request handlers return a result; only main calls $done.
    function main() {
        const path = $request.url.split("?")[0],
            platform = platformKey($request);
        try {
            let result = {};
            if (path.endsWith("/player/ad_break")) result = emptyPlayback();
            else if (path.endsWith("/log_event"))
                result = prepareLogEvent($request.headers, platform);
            else if (path.endsWith("/initplayback"))
                result = preparePlayback($request.body, platform);
            else if (
                path.endsWith("/youtubei/v1/player") &&
                readOptions().nativeDownload === true
            )
                result = prepareOfflineDownload($request.body);
            else if (path.endsWith("/videoplayback")) {
                const options = readOptions();
                if (
                    options.autoHd !== false &&
                    $request.body instanceof Uint8Array &&
                    $request.body.length
                )
                    result = {
                        body: forceHighestQuality($request.body, $request.url),
                    };
            }
            $done(result);
        } catch (error) {
            console.log("YouTube request: " + error);
            if (path.endsWith("/initplayback")) {
                clearKeys(platform);
                $done(emptyPlayback());
            } else $done({});
        }
    }
    function emptyPlayback() {
        return {
            response: {
                status: 200,
                headers: { "Content-Type": "application/x-protobuf" },
                body: new Uint8Array(),
            },
        };
    }
    function prepareLogEvent(requestHeaders, platform) {
        const headers = { ...requestHeaders };
        if (!readConfig()[platform]?.clientKey)
            for (const name of Object.keys(headers))
                if (name.toLowerCase() === "x-youtube-hot-hash-data")
                    delete headers[name];
        return { headers };
    }
    function preparePlayback(body, platform) {
        const key = readConfig()[platform]?.encryptKey;
        const encrypted = body instanceof Uint8Array && bytesField(body, 3);
        const clientKey = encrypted && bytesField(encrypted, 5);
        if (key && clientKey && sameBytes(clientKey, decodeBase64(key)))
            return {};
        clearKeys(platform);
        return emptyPlayback();
    }

    function prepareOfflineDownload(body) {
        if (!(body instanceof Uint8Array) || !body.length) return {};
        const fields = wireFields(body),
            offline = fields.filter((field) => field.no === 8),
            params = fields.filter((field) => field.no === 12);
        if (
            offline.length !== 1 ||
            offline[0].wire !== 0 ||
            offline[0].data.length !== 1 ||
            offline[0].data[0] !== 1 ||
            params.length !== 1 ||
            params[0].wire !== 2 ||
            params[0].data.length !== 0
        )
            return {};
        // Match the native offline request's absent params. Preserve nonempty
        // params, online playback, credentials, integrity tokens and all flags.
        return {
            body: concatBytes(
                fields
                    .filter((field) => field !== params[0])
                    .map((field) => field.raw),
            ),
        };
    }

    // 2. Auto HD: edit only SABR quality preferences; preserve every other field.
    function setQuality(bytes, targetHeight = 2160) {
        // A fresh manual selection plus sticky resolution prevents ABR downgrades.
        // 确保传递给协议的高度参数最大不超过 2160 (4K)
        const safeHeight = Math.min(targetHeight, 2160);
        const values = new Map([
            [13, 0],
            [14, 2],
            [16, safeHeight],
            [21, safeHeight],
            [26, 3],
            [30, 0],
        ]);
        const seen = new Set(),
            chunks = [];
        for (const field of wireFields(bytes)) {
            if (field.wire === 0 && values.has(field.no)) {
                chunks.push(varint(field.no * 8), varint(values.get(field.no)));
                seen.add(field.no);
            } else chunks.push(field.raw);
        }
        for (const [no, value] of values)
            if (!seen.has(no)) chunks.push(varint(no * 8), varint(value));
        return concatBytes(chunks);
    }

    function selectQuality(fields, url) {
        try {
            const match = /[?&]id=([^&]+)/.exec(url);
            if (!match) return;
            const quality = readConfig(QUALITY_KEY)?.[decodeURIComponent(match[1])];
            let height = quality?.height;
            
            // 如果读取不到配置，默认将高度限定为 2160
            if (!Number.isInteger(height) || height <= 0 || height > 0x7fffffff) {
                height = 2160;
            } else if (height >= 4320) {
                height = 2160; // 强制降级 8K -> 4K
            }

            return { height };
        } catch {
            return { height: 2160 };
        }
    }

    function forceHighestQuality(bytes, url) {
        const fields = wireFields(bytes);
        const quality = selectQuality(fields, url);
        const targetHeight = quality ? quality.height : 2160;

        const chunks = [];
        let found = false;

        for (const field of fields) {
            if (field.no === 1 && field.wire === 2) {
                // 修改控制状态中的分辨率上线为 2160p
                const state = setQuality(field.data, targetHeight);
                chunks.push(
                    varint(10),
                    varint(state.length),
                    state,
                );
                found = true;
            } else {
                // 保留其他所有原生的 protobuf 字段（包括完整的原始 formats）
                // 这样既能限定最高画质为 2160p，又绝不会破坏签名或导致解码报错
                chunks.push(field.raw);
            }
        }

        // 如果原始请求中没有包含状态字段，补全写入 2160p 控制状态
        if (!found) {
            const state = setQuality(new Uint8Array(), targetHeight);
            chunks.push(
                varint(10),
                varint(state.length),
                state,
            );
        }

        return concatBytes(chunks);
    }

    // 3. Configuration and persistent key state.
    function readOptions(defaults = {}) {
        return typeof $argument === "string" && !$argument.includes("{{{")
            ? { ...defaults, ...JSON.parse($argument) }
            : defaults;
    }
    function platformKey(request) {
        return Object.entries(request.headers ?? {}).some(
            ([name, value]) =>
                name.toLowerCase() === "user-agent" && /music/i.test(value),
        )
            ? "youtubeMusic"
            : "youtube";
    }
    function readConfig(key = CONFIG_KEY) {
        try {
            return JSON.parse($persistentStore.read(key) || "{}");
        } catch {
            return {};
        }
    }
    function writeConfig(config) {
        $persistentStore.write(JSON.stringify(config), CONFIG_KEY);
    }
    function clearKeys(platform) {
        const config = readConfig();
        if (config[platform]) {
            delete config[platform];
            writeConfig(config);
        }
    }

    // 4. Byte helpers are local because Surge loads each script independently.
    function bytesField(bytes, number) {
        return wireFields(bytes).find(
            (field) => field.no === number && field.wire === 2,
        )?.data;
    }
    function concatBytes(chunks) {
        const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
        let offset = 0;
        for (const bytes of chunks) {
            result.set(bytes, offset);
            offset += bytes.length;
        }
        return result;
    }
    function sameBytes(a, b) {
        return (
            a === b ||
            (a.length === b.length && a.every((value, i) => value === b[i]))
        );
    }
    function varint(value) {
        const bytes = [];
        do {
            bytes.push(value % 128 | (value > 127 ? 128 : 0));
            value = Math.floor(value / 128);
        } while (value);
        return new Uint8Array(bytes);
    }
    function wireFields(bytes) {
        const fields = [];
        let offset = 0;
        function read() {
            let value = 0,
                scale = 1;
            for (let i = 0; i < 5; i++) {
                if (offset >= bytes.length)
                    throw new Error("Truncated protobuf varint");
                const byte = bytes[offset++];
                value += (byte & 127) * scale;
                if (!(byte & 128)) {
                    if (value > 0xffffffff)
                        throw new Error("Protobuf length/tag overflow");
                    return value;
                }
                scale *= 128;
            }
            throw new Error("Invalid protobuf varint");
        }
        while (offset < bytes.length) {
            const start = offset,
                tag = read(),
                no = Math.floor(tag / 8),
                wire = tag % 8;
            if (!no) throw new Error("Invalid protobuf field");
            let payloadStart = offset;
            if (wire === 2) {
                const length = read();
                payloadStart = offset;
                offset += length;
            } else if (wire === 1) offset += 8;
            else if (wire === 5) offset += 4;
            else if (wire === 0) {
                let count = 0,
                    byte;
                do {
                    if (offset >= bytes.length || count++ === 10)
                        throw new Error("Invalid protobuf integer");
                    byte = bytes[offset++];
                    if (count === 10 && byte > 1)
                        throw new Error("Protobuf integer overflow");
                } while (byte & 128);
            } else throw new Error("Unsupported protobuf wire type " + wire);
            if (offset > bytes.length)
                throw new Error("Truncated protobuf field");
            fields.push({
                no,
                wire,
                data: bytes.subarray(payloadStart, offset),
                raw: bytes.subarray(start, offset),
            });
        }
        return fields;
    }
    function decodeBase64(value) {
        const alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let buffer = 0,
            bits = 0;
        const output = [];
        for (const character of value.replace(/-/g, "+").replace(/_/g, "/")) {
            if (/\s|=/.test(character)) continue;
            const index = alphabet.indexOf(character);
            if (index < 0) throw new Error("Invalid base64 key");
            buffer = (buffer << 6) | index;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                output.push((buffer >>> bits) & 255);
            }
        }
        return new Uint8Array(output);
    }

    main();
})();
