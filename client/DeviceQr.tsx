import { useMemo } from 'react';
import qrcode from './vendor/qrcode';
import { publicMachineUrl } from './machine-links';

export default function DeviceQr({ url, name = '我的电脑' }: { url: string; name?: string }) {
  const link = useMemo(() => {
    const target = new URL('https://dili.discoverpaw.com/');
    target.hash = `/machines?add=${encodeURIComponent(publicMachineUrl(url))}&name=${encodeURIComponent(name)}`;
    return target.href;
  }, [url, name]);
  const svg = useMemo(() => { const qr = qrcode(0, 'M'); qr.addData(link); qr.make(); return qr.createSvgTag({ scalable: true, margin: 4 }); }, [link]);
  return <section className="device-qr" aria-label="扫码添加设备"><div role="img" aria-label="设备连接二维码" dangerouslySetInnerHTML={{ __html: svg }} /><div><strong>扫码添加到手机</strong><p>用手机相机或 PWA 扫码，验证所有者密码后连接。</p><a href={link} target="_blank" rel="noreferrer">在 PWA 中添加此设备</a></div></section>;
}
