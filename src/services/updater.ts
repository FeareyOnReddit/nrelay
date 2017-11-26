import fs = require('fs');
import path = require('path');
import { exec } from 'child_process';

import https = require('https');
import stream = require('stream');
import { createWriteStream, PathLike } from 'fs';
import { Log, LogLevel } from './../core/plugin-module';

const ASSET_ENDPOINT = 'https://static.drips.pw/rotmg/production/#/';
const PACKET_REGEX = /public static const ([A-Z_]+):int = (\d+);/g;
const dir = path.dirname(require.main.filename);

export class Updater {

    static latestVersion: string;

    static checkVersion(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            https.get(ASSET_ENDPOINT.replace('#', 'current') + 'version.txt', (res) => {
                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    if (!raw) {
                        resolve(false);
                        return;
                    }
                    this.latestVersion = raw;
                    const filename = path.join(dir, 'src', 'services', 'updater-assets', 'version.txt');
                    let currentVersion = null;
                    try {
                        currentVersion = fs.readFileSync(filename, { encoding: 'utf8' });
                    } catch {
                        try {
                            fs.mkdirSync(path.join(dir, 'src', 'services', 'updater-assets'));
                        } catch (error) {
                            if (error.code !== 'EEXIST') {
                                reject(error);
                            }
                        }
                        fs.writeFileSync(filename, '', { encoding: 'utf8' });
                    }
                    if (currentVersion !== raw) {
                        resolve(true);
                        return;
                    }
                    resolve(false);
                });
                res.on('error', (error) => {
                    reject(false);
                });
            });
        });
    }

    static getLatest(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.latestVersion) {
                this.checkVersion().then(() => {
                    reject();
                }).catch((error) => {
                    Log('Updater', 'Error getting latest version', LogLevel.Error);
                });
            }
            const url = ASSET_ENDPOINT.replace('#', 'current');

            const clientPath = path.join(dir, 'src', 'services', 'updater-assets', 'client.swf');
            const groundTypesPath = path.join(dir, 'resources', 'GroundTypes.xml');
            const objectsPath = path.join(dir, 'resources', 'Objects.xml');

            this.emptyFile(clientPath);
            this.emptyFile(groundTypesPath);
            this.emptyFile(objectsPath);

            const clientStream = createWriteStream(clientPath);
            const groundTypesStream = createWriteStream(groundTypesPath);
            const objectsStream = createWriteStream(objectsPath);

            Promise.all([
                new Promise((resolve1, reject1) => {
                    Log('Updater', 'Downloading latest client.swf', LogLevel.Info);
                    https.get(url + 'client.swf', (res) => {
                        res.on('data', (chunk) => {
                            clientStream.write(chunk);
                        });
                        res.on('end', () => {
                            Log('Updater', 'Downloaded client.swf', LogLevel.Success);
                            clientStream.end();
                            resolve1();
                        });
                        res.on('error', (error) => {
                            reject1(error);
                        });
                    });
                }),
                new Promise((resolve2, reject2) => {
                    Log('Updater', 'Downloading latest GroundTypes.xml', LogLevel.Info);
                    https.get(url + 'xmlc/GroundTypes.xml', (res) => {
                        res.on('data', (chunk) => {
                            groundTypesStream.write(chunk);
                        });
                        res.on('end', () => {
                            Log('Updater', 'Downloaded GroundTypes.xml', LogLevel.Success);
                            groundTypesStream.end();
                            resolve2();
                        });
                        res.on('error', (error) => {
                            reject2(error);
                        });
                    });
                }),
                new Promise((resolve3, reject3) => {
                    Log('Updater', 'Downloading latest Objects.xml', LogLevel.Info);
                    https.get(url + 'xmlc/Objects.xml', (res) => {
                        res.on('data', (chunk) => {
                            objectsStream.write(chunk);
                        });
                        res.on('end', () => {
                            Log('Updater', 'Downloaded Objects.xml', LogLevel.Success);
                            objectsStream.end();
                            resolve3();
                        });
                        res.on('error', (error) => {
                            reject3(error);
                        });
                    });
                })
            ]).then(() => {
                Log('Updater', 'Unpacking client.swf', LogLevel.Info);
                this.unpackSwf().then(() => {
                    Log('Updater', 'Unpacked client.swf', LogLevel.Success);
                    Log('Updater', 'Updating assets', LogLevel.Info);
                    this.updateAssets().then(() => {
                        Log('Updater', 'Finished! Rebuild the source to apply the update.', LogLevel.Success);
                        resolve();
                    }).catch((updateError) => {
                        reject(updateError);
                    });
                }).catch((error) => {
                    reject(error);
                    Log('Updater', 'Error while unpacking swf', LogLevel.Error);
                });
            }).catch((error) => {
                Log('Updater', 'Error: ' + error.message, LogLevel.Error);
            });
        });
    }

    private static emptyFile(filePath: PathLike): void {
        try {
            fs.truncateSync(filePath, 0);
        } catch {
            fs.writeFileSync(filePath, '', { encoding: 'utf8' });
        }
    }

    private static unpackSwf(): Promise<any> {
        return new Promise((resolve, reject) => {
            const args = [
                '-jar',
                ('"' + path.join(dir, 'lib', 'jpexs', 'ffdec.jar') + '"'),
                '-selectclass kabam.rotmg.messaging.impl.GameServerConnection',
                '-export script',
                ('"' + path.join(dir, 'src', 'services', 'updater-assets', 'decompiled') + '"'),
                ('"' + path.join(dir, 'src', 'services', 'updater-assets', 'client.swf') + '"')
            ];
            exec('java ' + args.join(' '), (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    private static updateAssets(): Promise<any> {
        return new Promise((resolve, reject) => {
            let raw = null;
            try {
                raw = fs.readFileSync(path.join(
                    dir,
                    'src', 'services', 'updater-assets', 'decompiled', 'scripts',
                    'kabam', 'rotmg', 'messaging', 'impl', 'GameServerConnection.as'
                ), { encoding: 'utf8' });
            } catch {
                reject();
                return;
            }
            const packets: {
                [id: string]: number
            } = {};
            let match = PACKET_REGEX.exec(raw);
            while (match != null) {
                packets[match[1].replace('_', '')] = +match[2];
                match = PACKET_REGEX.exec(raw);
            }
            this.updatePackets(packets);
            this.updateVersion();
            resolve();
        });
    }

    private static updatePackets(newPackets: { [id: string]: number }): void {
        const filePath = path.join(dir, 'src', 'networking', 'packet-type.ts');
        fs.truncateSync(filePath, 0);
        let raw = 'export enum PacketType {\n';
        const keys = Object.keys(newPackets);
        for (let i = 0; i < keys.length; i++) {
            raw += ('    ' + keys[i] + ' = ' + newPackets[keys[i]] + (i === keys.length - 1 ? '\n' : ',\n'));
        }
        raw += '}\n';
        fs.writeFileSync(filePath, raw, { encoding: 'utf8' });
        Log('Updater', 'Updated PacketType enum', LogLevel.Info);
    }

    private static updateVersion(): void {
        const filePath = path.join(dir, 'src', 'services', 'updater-assets', 'version.txt');
        try {
            fs.truncateSync(filePath, 0);
        } catch {
        }
        fs.writeFileSync(filePath, this.latestVersion, { encoding: 'utf8' });
    }
}
