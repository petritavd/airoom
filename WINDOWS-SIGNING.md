# Signing the Windows build

Step by step, from no certificate to a Windows installer that opens without
"Windows protected your PC". Written 29 September 2026 against electron-builder
25.1.8 and Microsoft's current Artifact Signing pages (the service was renamed
from Trusted Signing; older docs and our own notes use the old name).

## Why it says dangerous today

The installer is not signed. Windows then has nothing to attach a reputation
to except the file's hash, and every new build is a new hash, so every release
starts from zero. Signing gives Windows a stable identity, "applyai OÜ", that
carries reputation from one release to the next. Two honest limits:

- Signing removes the "unknown publisher" line at once. The "not commonly
  downloaded" prompt fades as downloads accumulate, over days to weeks.
- An EV certificate used to grant reputation instantly and no longer reliably
  does, so it is not worth the extra money here.

## Part 1. Get a signing identity

Two routes. Route A is cheaper and signs inside our GitHub workflow with no
hardware. Route B is the fallback if Azure keeps refusing the billing account.

### Route A: Azure Artifact Signing (about $10 a month)

You already have the two things it builds on: a Microsoft Entra tenant (with
a Global Admin account and the company's domains verified in it) and a
Microsoft Partner Center business verification of applyai OÜ from February.
Use the legal name, Partner ID and registered address exactly as Partner
Center has them wherever the portal asks.

1. **A subscription.** Azure resources bill to a subscription. The applyai OÜ
   billing account showed "Account under review" on 14 September, which blocks
   creating one. Clear it first: in the portal, Cost Management + Billing, then
   Billing scopes, open the account, and use Support + troubleshooting to open a
   free "Subscription management" case saying the account is years old,
   untouched, and blocked. If that drags on, sign up for a fresh pay-as-you-go
   account with the tenant's Global Admin account instead; a new account's
   review is automatic and takes about a day.
2. **Register the provider.** Subscriptions, pick yours, Resource providers,
   register `Microsoft.CodeSigning`.
3. **Create the account.** Search "Artifact Signing", create an Artifact
   Signing account, region West Europe, Basic tier. Note the account name;
   the endpoint for that region is `https://weu.codesigning.azure.net`.
4. **Give yourself the verifier role.** On the account, Access control (IAM),
   assign "Artifact Signing Identity Verifier" to your own user. Without it the
   New identity button stays dimmed.
5. **Identity validation.** On the account, Identity validations, New
   identity, type Public Trust, Organization. Legal name, registration number,
   address and contact email exactly as Partner Center has them; the contact
   address must be on a domain verified in the tenant. Answer the
   verification email promptly; a failed email check means a new request.
   Microsoft says 1 to 20 business days. It rarely takes the long end when the
   entity already exists in public records.
6. **Certificate profile.** When the identity shows Completed, create a
   certificate profile of type Public Trust on it. Note the profile name. The
   certificate's subject will read "applyai OÜ".
7. **A robot account for the build.** In Entra ID, App registrations, New
   registration, name it `airoom-signing`. Under Certificates & secrets add a
   client secret (24 months) and copy it once. On the Artifact Signing
   account, Access control (IAM), assign "Artifact Signing Certificate Profile
   Signer" to that app. You now have three values: the tenant ID, the app's
   client ID, and the secret.
8. **GitHub secrets.** In the airoom repository, Settings, Secrets and
   variables, Actions, add `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
   `AZURE_CLIENT_SECRET`. Never paste them anywhere else.

### Route B: an OV certificate with cloud signing (about $300 to $500 a year)

Only if Route A stays blocked. Since 2023 the private key must live on approved
hardware, so buy the certificate together with the vendor's cloud signing
service rather than a USB token, or the GitHub workflow cannot sign at all.

1. Order an OV code signing certificate plus cloud signing from SSL.com
   (eSigner) or DigiCert (KeyLocker). Certum is the EU alternative.
2. Organization validation: registry extract for applyai OÜ, a phone number
   that can be verified, and the signer's ID. Usually 1 to 3 business days.
3. Put the vendor's credentials in GitHub secrets, and point electron-builder
   at the vendor's signing CLI through `win.signtoolOptions.sign` (a small
   script that calls their tool on each file). The vendor's docs have a sample
   for electron-builder; follow that rather than this page from here on.

## Part 2. Wire it into the build

Signing runs only on Windows: electron-builder installs the `TrustedSigning`
PowerShell module and calls `Invoke-TrustedSigning` for every executable it
produces. That means the release installer must come from the GitHub
workflow, not from this Mac. Local Mac builds of the Windows installer keep
working and stay unsigned, which is fine for the VM.

Keep `desktop/package.json` as it is, and pass the signing options only in
CI, so a local build never trips over missing credentials. In
`.github/workflows/windows.yml`, replace the build step with:

```yaml
      - name: Build the installer (signed)
        working-directory: desktop
        env:
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
        run: >
          npx electron-builder --win nsis --x64 --publish never
          --config.win.azureSignOptions.endpoint=https://weu.codesigning.azure.net
          --config.win.azureSignOptions.codeSigningAccountName=ACCOUNT_NAME
          --config.win.azureSignOptions.certificateProfileName=PROFILE_NAME
```

Put the real account and profile names from steps 3 and 6 in place of the two
placeholders. electron-builder authenticates with the three variables, signs
`airoom.exe` inside the package and the NSIS installer around it, and
timestamps both, so the signature outlives the certificate.

If `Install-Module -Name TrustedSigning` fails on the runner, add this step
before the build:

```yaml
      - run: Install-PackageProvider -Name NuGet -Force -Scope CurrentUser
        shell: pwsh
```

## Part 3. Verify before shipping

Download the `airoom-windows-x64` artifact from the green run and check it in
the Windows VM, from PowerShell in the folder that holds the installer:

```powershell
Get-AuthenticodeSignature .\airoom-0.1.17-x64.exe | Format-List Status, SignerCertificate
```

Expect `Status: Valid` and a signer whose subject contains `applyai`. Then run
the installer: the dialog must name applyai OÜ as the publisher instead of
"Unknown publisher". A "not commonly downloaded" prompt on the very first
signed build is normal and disappears with downloads.

## Part 4. Release flow, changed in one place

Everything in the release recipe stays the same except where the Windows
installer comes from. Take the signed artifact from the workflow run for the
release commit instead of the Mac-built file:

```bash
unzip -o ~/Downloads/airoom-windows-x64.zip -d /tmp/airoom-win
cp /tmp/airoom-win/airoom-0.1.17-x64.exe landing/downloads/airoom-x64.exe
```

Then the same "Ship" commit, push, and the live hash check. Update the Windows
card on the landing page at that point: drop the SmartScreen note under the
button and the "beta" label, since neither is true any more.

## Part 5. Reputation, and what to do if the prompt lingers

- Keep the same certificate profile across releases. Reputation attaches to
  the signing identity; a new profile starts over.
- If a signed build still gets "not commonly downloaded" after two weeks of
  real downloads, submit the signed installer to Microsoft Security
  Intelligence for review at microsoft.com/wdsi/filesubmission, as a software
  developer. Microsoft's own FAQ recommends exactly this.
- Never sign a build you did not make. The identity is the company's.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Account under review" when creating a subscription | Azure risk review on the billing account | Free Subscription management support case, or a fresh pay-as-you-go account |
| New identity button dimmed | missing verifier role | Assign "Artifact Signing Identity Verifier" to yourself on the account |
| Identity validation stuck at In Progress | verification email unanswered or documents requested | Check the contact address, including spam; answer within the email's window |
| 403 from `Invoke-TrustedSigning` | robot account lacks the signer role, or wrong region endpoint | Assign "Artifact Signing Certificate Profile Signer"; endpoint must match the account's region |
| 401 from `Invoke-TrustedSigning` | client secret expired or mistyped | Create a new secret, update the GitHub secret |
| Build fails on the Mac after adding options to package.json | signing options only work on Windows | Keep them in the workflow's CLI flags, as above |
| Signature valid but SmartScreen still warns | reputation not built yet | Wait, then submit the file to Microsoft if it persists |
