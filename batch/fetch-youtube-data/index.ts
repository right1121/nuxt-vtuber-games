import { google } from 'googleapis'

const API_KEY = 'AIzaSyCcRyMIFrqLO8TYqny1Nzg4QSj3XeqfLag'

const youtube = google.youtube({
  version: 'v3',
  auth: API_KEY,
});

const main = async () => {
  const res = await youtube.search.list({
    channelId: 'UC_vMYWcDjmfdpH6r4TTn1MQ',
    part: ['snippet'],
    order: "date",
    relevanceLanguage: "ja",
    type: ["video"]
  })

  res.data.items?.forEach((item) => {
    console.log(item)
  })
};

main().catch(console.error);
