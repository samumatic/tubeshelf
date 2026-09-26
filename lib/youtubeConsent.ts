// EU-geolocated requests carrying only the legacy CONSENT=YES+1 cookie get
// bounced through consent.youtube.com first; SOCS is the cookie YouTube
// currently checks to skip that interstitial.
export const YOUTUBE_CONSENT_COOKIE =
  "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA2X3AwGgJlbiAAKAA";
