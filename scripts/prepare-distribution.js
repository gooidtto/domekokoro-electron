#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const modelDir = path.join(root, 'build', 'models', 'Kokoro-82M-v1.1-zh', 'int8');
const sidecarDir = path.join(root, 'build', 'sidecar');
const baseUrl = process.env.KOKORO_MODEL_BASE_URL || 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1';
const files = [['kokoro-v1.1-zh.int8.onnx','kokoro-v1.1-zh.int8.onnx'],['voices-v1.1-zh.bin','voices-v1.1-zh.bin']];
function download(url,target){return new Promise((resolve,reject)=>{fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target)&&fs.statSync(target).size>0)return resolve();const req=https.get(url,res=>{if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();return download(res.headers.location,target).then(resolve,reject);}if(res.statusCode!==200){res.resume();return reject(new Error('Download failed '+res.statusCode+': '+url));}const out=fs.createWriteStream(target);res.pipe(out);out.on('finish',()=>out.close(resolve));out.on('error',reject);});req.on('error',reject);});}
function run(command,args){const result=spawnSync(command,args,{cwd:root,stdio:'inherit',shell:process.platform==='win32'});if(result.status!==0)process.exit(result.status||1);}
async function main(){fs.rmSync(path.join(root,'build'),{recursive:true,force:true});fs.mkdirSync(modelDir,{recursive:true});for(const [remote,local] of files){console.log('Downloading '+remote+'...');await download(baseUrl+'/'+remote,path.join(modelDir,local));}fs.mkdirSync(sidecarDir,{recursive:true});const pyinstaller=process.platform==='win32'?'pyinstaller.exe':'pyinstaller';run(pyinstaller,['--noconfirm','--clean','--onedir','--name','kokoro-sidecar','--distpath',sidecarDir,'--workpath',path.join(root,'build','pyinstaller-work'),'--specpath',path.join(root,'build'),path.join(root,'sidecar','kokoro-onnx','app.py')]);console.log('Kokoro packaged runtime prepared.');}
main().catch(error=>{console.error(error.stack||error);process.exit(1);});