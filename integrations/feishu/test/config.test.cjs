const {test}=require('node:test');const assert=require('node:assert/strict');const {internalHost,loadConfig}=require('../config.cjs');
test('private-looking public names are not internal IP addresses',()=>{
 for(const h of ['10.evil.example','127.0.0.1.example','192.168.example','172.16.example']){assert.equal(internalHost(h),false);assert.throws(()=>loadConfig({PREREAD_BASE_URL:'https://'+h}),/internal/);}
 for(const h of ['10.1.2.3','127.0.0.1','192.168.1.2','172.16.0.1','localhost','preread','[::1]'])assert.equal(internalHost(h),true);
});
