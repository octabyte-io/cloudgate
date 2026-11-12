/**
 * Random lowercase letters and digits, `quantity` long. `AiService.deploy`
 * uses six of them as its stack name's suffix; nothing here is a secret, so
 * `Math.random` is enough. It came from the `template.toml` reader's
 * generators, which a Template no longer uses (ADR-0064 generates secrets
 * from a cryptographically secure source).
 */
export const generatePassword = (quantity = 16): string => {
  const characters =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < quantity; i++) {
    password += characters.charAt(
      Math.floor(Math.random() * characters.length),
    );
  }
  return password.toLowerCase();
};
