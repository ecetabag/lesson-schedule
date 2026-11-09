// Public configuration for this booking site. Never put API secrets here.
// For another business, create a separate deployment with its own backend,
// Google Sheet, Calendar, and approved provider emails.
window.APPOINTMENT_APP = {
  title: 'Waterpolo Lesson Schedule',
  participantLabel: 'Participant name',
  contactLabel: 'Contact email',
  providerLabel: 'Provider',
};

// Optional for GitHub Pages. When hosted on Vercel, the site automatically
// uses its own /api/index endpoint and does not need this setting.
window.WATERPOLO_API_URL = '';
