import crypto from "node:crypto";
import fs from "node:fs";
import forge from "node-forge";
import { exists, p, run, runElevated } from "./util";
import { t } from "../src/i18n";

const caCert = p("ssl", "ca.crt");
const caKey = p("ssl", "ca.key");

function keypair() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const key = forge.pki.privateKeyFromPem(pem);
  return { key, pub: forge.pki.setRsaPublicKey(key.n, key.e), pem };
}

function newCert(pub: forge.pki.PublicKey, days: number) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = `01${crypto.randomBytes(15).toString("hex")}`;
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + days * 86400e3);
  return cert;
}

function ca() {
  if (!exists(caCert)) {
    const { key, pub, pem } = keypair();
    const cert = newCert(pub, 3650 * 2);
    const attrs = [
      { name: "commonName", value: `lokaldev CA ${crypto.randomBytes(4).toString("hex")}` },
      { name: "organizationName", value: "lokaldev" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(key, forge.md.sha256.create());
    fs.writeFileSync(caKey, pem);
    fs.writeFileSync(caCert, forge.pki.certificateToPem(cert));
    trustedCache = undefined;
  }
  return {
    cert: forge.pki.certificateFromPem(fs.readFileSync(caCert, "utf8")),
    key: forge.pki.privateKeyFromPem(fs.readFileSync(caKey, "utf8")),
  };
}

const caName = () => ca().cert.subject.getField("CN").value as string;

/** A certificate to replace: missing key, unreadable, issued by another CA or expiring within 30 days. */
function stale(cert: string, key: string, authority: forge.pki.Certificate) {
  if (!exists(cert) || !exists(key)) return true;
  try {
    const c = forge.pki.certificateFromPem(fs.readFileSync(cert, "utf8"));
    forge.pki.privateKeyFromPem(fs.readFileSync(key, "utf8"));
    return c.issuer.getField("CN")?.value !== authority.subject.getField("CN").value || c.validity.notAfter.getTime() < Date.now() + 30 * 86400e3;
  } catch {
    return true;
  }
}

/** Returns cert/key paths for a domain, issuing them from the local CA when missing or outdated. */
export function certFor(domain: string) {
  const cert = p("ssl", `${domain}.crt`);
  const key = p("ssl", `${domain}.key`);
  const authority = ca();
  if (stale(cert, key, authority.cert)) {
    const pair = keypair();
    const c = newCert(pair.pub, 800);
    c.setSubject([{ name: "commonName", value: domain }]);
    c.setIssuer(authority.cert.subject.attributes);
    c.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [{ type: 2, value: domain }, { type: 2, value: `*.${domain}` }, ...(domain === "localhost" ? [{ type: 7, ip: "127.0.0.1" }] : [])],
      },
      { name: "authorityKeyIdentifier", keyIdentifier: authority.cert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    c.sign(authority.key, forge.md.sha256.create());
    fs.writeFileSync(key, pair.pem);
    fs.writeFileSync(cert, forge.pki.certificateToPem(c));
  }
  return { cert, key };
}

let trustedCache: boolean | undefined;

// Trusted when present in the machine Root store (current) or the user store (older versions).
export async function caTrusted() {
  if (trustedCache === undefined) {
    const has = async (...store: string[]) => (await run("certutil", [...store, "-store", "Root", caName()])).code === 0;
    trustedCache = exists(caCert) && ((await has()) || (await has("-user")));
  }
  return trustedCache;
}

/** Adds the CA to the machine Root store, like Laragon: a single UAC prompt instead of the certificate warning dialog. */
export async function trustCa() {
  ca();
  await runElevated("certutil.exe", `-addstore -f Root "${caCert}"`);
  trustedCache = undefined;
  if (!(await caTrusted())) throw new Error(t("The certificate wasn't added to the trusted store (UAC cancelled?)"));
}
