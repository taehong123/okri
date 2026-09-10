const OKRI_PLAY_QUERY = 'newer_than:30d ("Google Play" OR "Play Console")';

function checkGooglePlayReviewFeedback() {
  const properties = PropertiesService.getScriptProperties();
  const endpoint = properties.getProperty('OKRI_STORE_FEEDBACK_URL');
  const secret = properties.getProperty('OKRI_STORE_FEEDBACK_SECRET');
  if (!endpoint || !secret) throw new Error('Set OKRI_STORE_FEEDBACK_URL and OKRI_STORE_FEEDBACK_SECRET in Script properties.');
  const threads = GmailApp.search(OKRI_PLAY_QUERY, 0, 20);
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      const messageId = message.getId();
      if (properties.getProperty('delivered_' + messageId)) return;
      const payload = JSON.stringify({
        messageId: messageId,
        from: message.getFrom(),
        subject: message.getSubject(),
        receivedAt: message.getDate().toISOString(),
        snippet: message.getPlainBody().replace(/\s+/g, ' ').slice(0, 900),
      });
      const signature = Utilities.computeHmacSha256Signature(payload, secret)
        .map(function (value) { return ('0' + (value & 255).toString(16)).slice(-2); }).join('');
      const response = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        contentType: 'application/json',
        payload: payload,
        headers: { 'x-okri-store-signature': 'sha256=' + signature },
        muteHttpExceptions: true,
      });
      if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
        properties.setProperty('delivered_' + messageId, new Date().toISOString());
      }
    });
  });
}

function installGooglePlayReviewTrigger() {
  ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'checkGooglePlayReviewFeedback';
  }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('checkGooglePlayReviewFeedback').timeBased().everyMinutes(5).create();
}
