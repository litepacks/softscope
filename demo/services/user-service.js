const MOCK_USERS = [
  { id: 'usr_1', name: 'Alice Smith', email: 'alice@example.com', role: 'admin', credits: 120 },
  { id: 'usr_2', name: 'Bob Jones', email: 'bob@example.com', role: 'member', credits: 45 },
  { id: 'usr_3', name: 'Charlie Brown', email: 'charlie@example.com', role: 'member', credits: 210 },
  { id: 'usr_4', name: 'Dana Scully', email: 'dana@example.com', role: 'moderator', credits: 350 }
];

export function listUsers() {
  return MOCK_USERS.map(user => formatUserProfile(user));
}

export function findUserById(id) {
  const user = MOCK_USERS.find(u => u.id === id);
  if (!user) return null;
  return formatUserProfile(user);
}

export function formatUserProfile(user) {
  return {
    id: user.id,
    displayName: formatDisplayName(user.name),
    maskedEmail: maskEmail(user.email),
    tier: calculateTier(user.credits),
    credits: user.credits
  };
}

export function formatDisplayName(name) {
  return name.trim().toUpperCase();
}

export function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const maskedLocal = local.length > 2
    ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1]
    : local[0] + '*';
  return `${maskedLocal}@${domain}`;
}

export function calculateTier(credits) {
  if (credits >= 200) return 'VIP';
  if (credits >= 100) return 'PRO';
  return 'BASIC';
}

export function unusedUserExport(user) {
  // Deliberately unused to show untouched functions
  return JSON.stringify(user, null, 2);
}
