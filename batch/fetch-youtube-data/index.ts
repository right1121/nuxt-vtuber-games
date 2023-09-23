/* eslint-disable no-console */
import { google, youtube_v3 as youtubeV3 } from 'googleapis'
import { Prisma, PrismaClient } from '@prisma/client'
import dayjs, { extend } from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { ITXClientDenyList } from '@prisma/client/runtime/library'
import 'dotenv/config'

type prismaTransacrion = Omit<PrismaClient, ITXClientDenyList>

extend(utc)
extend(timezone)
dayjs.tz.setDefault('Asia/Tokyo')

const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
})

const API_KEY = process.env.NUXT_GOOGLE_API_KEY

const youtube = google.youtube({
  version: 'v3',
  auth: API_KEY,
})

const programId = 'get_channel_video_batch'

const callYoutubeAPI = async (
  channelId: string,
  lastDatetime: dayjs.Dayjs,
  firstDatetime: dayjs.Dayjs,
  pageToken: string = '',
  preItems: youtubeV3.Schema$SearchResult[] = [],
): Promise<youtubeV3.Schema$SearchResult[]> => {
  const res = await youtube.search
    .list({
      part: ['snippet'],
      channelId,
      order: 'date',
      maxResults: 50,
      relevanceLanguage: 'ja',
      type: ['video'],
      videoCategoryId: '20',
      publishedAfter: lastDatetime.format(),
      publishedBefore: firstDatetime.format(),
      pageToken,
    })
    .catch((cause) => {
      throw new Error('YouTubeAPIの呼び出しミス', { cause })
    })

  const items = res.data.items || []
  const nextPageToken = res.data.nextPageToken
  if (!nextPageToken) {
    return [...preItems, ...items]
  }
  const nestItems = await callYoutubeAPI(
    channelId,
    lastDatetime,
    firstDatetime,
    nextPageToken,
    items,
  )

  return [...preItems, ...nestItems]
}

const updateBatchEvent = async (
  tx: prismaTransacrion,
  channelId: string,
  now: dayjs.Dayjs,
) => {
  const event = await tx.channel_video_batch_event.findFirst({
    where: {
      channel_id: channelId,
    },
    orderBy: {
      event_id: 'desc',
    },
  })
  const firstDatetime = event
    ? dayjs(event.last_datetime).tz()
    : dayjs('2017-01-01T00:00:00Z').tz()
  const lastDatetime = (() => {
    const _d = dayjs(firstDatetime).tz().add(6, 'month')

    const now = dayjs.tz()
    return now < _d ? now : _d
  })()
  await tx.channel_video_batch_event.create({
    data: {
      channel_id: channelId,
      first_datetime: firstDatetime.format(),
      last_datetime: lastDatetime.format(),
      created_at: now.format(),
      created_user: programId,
      updated_at: now.format(),
      updated_user: programId,
      program_id: programId,
    },
  })

  return {
    firstDatetime,
    lastDatetime,
  }
}

class BatchResult {
  #successCount: number
  get successCount() {
    return this.#successCount
  }

  #failedCount: number
  get failedCount() {
    return this.#failedCount
  }

  constructor() {
    this.#successCount = 0
    this.#failedCount = 0
  }

  get total() {
    return this.successCount + this.failedCount
  }

  success() {
    this.#successCount += 1
  }

  failed() {
    this.#failedCount += 1
  }
}

/**
 * 動画一覧取得バッチ
 *
 * channelテーブルに登録しているチャンネルの動画を取得する
 * 取得範囲は前回の正常終了時間から現在時刻まで
 * 取得範囲が1年を超える場合は1年にする
 */
const main = async () => {
  console.info('動画一覧取得バッチ起動')

  const channels = await prisma.channel.findMany()
  const result = new BatchResult()

  const now = dayjs().tz()

  for (const channel of channels) {
    console.info(`[${channel.channel_id}]`, channel.name, 'start')

    await prisma
      .$transaction(async (prisma) => {
        const res = await updateBatchEvent(
          prisma,
          channel.channel_id,
          now,
        ).catch((cause) => {
          throw new Error('バッチイベントの更新エラー', { cause })
        })

        const items = await callYoutubeAPI(
          channel.channel_id,
          res.firstDatetime,
          res.lastDatetime,
        )

        console.info('%d件処理', items.length)

        const data: Prisma.videoCreateManyInput[] = items.map(
          (item): Prisma.videoCreateManyInput => {
            const publishedAt = dayjs(item.snippet?.publishedAt).tz()

            return {
              channel_id: channel.channel_id,
              video_id: item.id?.videoId as string,
              title: item.snippet?.title as string,
              published_at: publishedAt.format(),
              created_at: now.format(),
              created_user: programId,
              updated_at: now.format(),
              updated_user: programId,
              program_id: programId,
            }
          },
        )

        await prisma.video.createMany({
          data,
        })
      })
      .then(() => result.success())
      .catch((error) => {
        result.failed()
        console.error(error)
      })
  }

  console.log(
    '合計(%d件) 成功(%d件) 失敗(%d件)',
    result.total,
    result.successCount,
    result.failedCount,
  )
}

main()
  .then(() => console.info('Done.'))
  .catch((error) => {
    console.error(error)
  })
  .finally(() => {
    prisma.$disconnect()
  })
