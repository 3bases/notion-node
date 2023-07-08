// import { promises as fs } from 'fs'
import * as notion from '@texonom/ntypes'
import { getBlockCollectionId, getPageContentBlockIds, parsePageId, uuidToId } from '@texonom/nutils'
import pMap from 'p-map'

import * as types from './types'

/**
 * Main Notion API client.
 */
export class NotionAPI {
  private readonly _apiBaseUrl: string
  private readonly _authToken?: string
  private readonly _activeUser?: string
  private readonly _userTimeZone: string

  constructor({
    apiBaseUrl = 'https://www.notion.so/api/v3',
    authToken,
    activeUser,
    userTimeZone = 'America/New_York'
  }: {
    apiBaseUrl?: string
    authToken?: string
    userLocale?: string
    userTimeZone?: string
    activeUser?: string
  } = {}) {
    this._apiBaseUrl = apiBaseUrl
    this._authToken = authToken
    this._activeUser = activeUser
    this._userTimeZone = userTimeZone
  }

  public async getPage(
    pageId: string,
    {
      concurrency = 3,
      fetchMissingBlocks = true,
      fetchCollections = true,
      signFileUrls = true,
      chunkLimit = 100,
      chunkNumber = 0,
      fetchOption
    }: {
      concurrency?: number
      fetchMissingBlocks?: boolean
      fetchCollections?: boolean
      signFileUrls?: boolean
      chunkLimit?: number
      chunkNumber?: number
      fetchOption?: types.FetchOption
    } = {}
  ): Promise<notion.ExtendedRecordMap> {
    const page = await this.getPageRaw(pageId, {
      chunkLimit,
      chunkNumber,
      fetchOption
    })
    const recordMap = page?.recordMap as notion.ExtendedRecordMap

    if (!recordMap?.block) throw new Error(`Notion page not found "${uuidToId(pageId)}"`)

    // ensure that all top-level maps exist
    recordMap.collection = recordMap.collection ?? {}
    recordMap.collection_view = recordMap.collection_view ?? {}
    recordMap.notion_user = recordMap.notion_user ?? {}

    // additional mappings added for convenience
    // note: these are not native notion objects
    recordMap.collection_query = {}
    recordMap.signed_urls = {}

    if (fetchMissingBlocks)
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // fetch any missing content blocks
        const pendingBlockIds = getPageContentBlockIds(recordMap).filter(id => !recordMap.block[id])

        if (!pendingBlockIds.length) break

        const newBlocks = await this.getBlocks(pendingBlockIds, fetchOption).then(res => res.recordMap.block)

        recordMap.block = { ...recordMap.block, ...newBlocks }
      }

    const contentBlockIds = getPageContentBlockIds(recordMap)

    // Optionally fetch all data for embedded collections and their associated views.
    // NOTE: We're eagerly fetching *all* data for each collection and all of its views.
    // This is really convenient in order to ensure that all data needed for a given
    // Notion page is readily available for use cases involving server-side rendering
    // and edge caching.
    if (fetchCollections) {
      const allCollectionInstances: Array<{
        collectionId: string
        collectionViewId: string
      }> = contentBlockIds.flatMap(blockId => {
        const block = recordMap.block[blockId].value
        const collectionId =
          block &&
          (block.type === 'collection_view' || block.type === 'collection_view_page') &&
          getBlockCollectionId(block, recordMap)

        if (collectionId)
          return block.view_ids?.map(collectionViewId => ({
            collectionId,
            collectionViewId
          }))
        else return []
      })

      // fetch data for all collection view instances
      await pMap(
        allCollectionInstances,
        async collectionInstance => {
          const { collectionId, collectionViewId } = collectionInstance
          const collectionView = recordMap.collection_view[collectionViewId]?.value

          try {
            const collectionData = await this.getCollectionData(collectionId, collectionViewId, collectionView, {
              fetchOption
            })

            recordMap.block = {
              ...recordMap.block,
              ...collectionData.recordMap.block
            }

            recordMap.collection = {
              ...recordMap.collection,
              ...collectionData.recordMap.collection
            }

            recordMap.collection_view = {
              ...recordMap.collection_view,
              ...collectionData.recordMap.collection_view
            }

            recordMap.notion_user = {
              ...recordMap.notion_user,
              ...collectionData.recordMap.notion_user
            }

            recordMap.collection_query![collectionId] = {
              ...recordMap.collection_query![collectionId],
              [collectionViewId]: (collectionData.result as any)?.reducerResults
            }
          } catch (err) {
            // It's possible for public pages to link to private collections, in which case
            // Notion returns a 400 error
            console.warn('NotionAPI collectionQuery error', pageId, err.message)
            console.error(err)
          }
        },
        {
          concurrency
        }
      )
    }

    // Optionally fetch signed URLs for any embedded files.
    // NOTE: Similar to collection data, we default to eagerly fetching signed URL info
    // because it is preferable for many use cases as opposed to making these API calls
    // lazily from the client-side.
    if (signFileUrls) await this.addSignedUrls({ recordMap, contentBlockIds, fetchOption })

    return recordMap
  }

  public async addSignedUrls({
    recordMap,
    contentBlockIds,
    fetchOption = {}
  }: {
    recordMap: notion.ExtendedRecordMap
    contentBlockIds?: string[]
    fetchOption?: types.FetchOption
  }) {
    recordMap.signed_urls = {}

    if (!contentBlockIds) contentBlockIds = getPageContentBlockIds(recordMap)

    const allFileInstances = contentBlockIds.flatMap(blockId => {
      const block = recordMap.block[blockId]?.value

      if (
        block &&
        (block.type === 'pdf' ||
          block.type === 'audio' ||
          (block.type === 'image' && block.file_ids?.length) ||
          block.type === 'video' ||
          block.type === 'file' ||
          block.type === 'page')
      ) {
        const source = block.type === 'page' ? block.format?.page_cover : block.properties?.source?.[0]?.[0]

        if (source) {
          if (!source.includes('secure.notion-static.com')) return []

          return {
            permissionRecord: {
              table: 'block',
              id: block.id
            },
            url: source
          }
        }
      }

      return []
    })

    if (allFileInstances.length > 0)
      try {
        const { signedUrls } = await this.getSignedFileUrls(allFileInstances, fetchOption)

        if (signedUrls.length === allFileInstances.length)
          for (let i = 0; i < allFileInstances.length; ++i) {
            const file = allFileInstances[i]
            const signedUrl = signedUrls[i]

            recordMap.signed_urls[file.permissionRecord.id] = signedUrl
          }
      } catch (err) {
        console.warn('NotionAPI getSignedfileUrls error', err)
      }
  }

  public async getPageRaw(
    pageId: string,
    {
      fetchOption,
      chunkLimit = 100,
      chunkNumber = 0
    }: {
      chunkLimit?: number
      chunkNumber?: number
      fetchOption?: types.FetchOption
    } = {}
  ) {
    const parsedPageId = parsePageId(pageId)

    if (!parsedPageId) throw new Error(`invalid notion pageId "${pageId}"`)

    const body = {
      pageId: parsedPageId,
      limit: chunkLimit,
      chunkNumber: chunkNumber,
      cursor: { stack: [] },
      verticalColumns: false
    }

    return this.fetch<notion.PageChunk>({
      endpoint: 'loadPageChunk',
      body,
      fetchOption
    })
  }

  public async getCollectionData(
    collectionId: string,
    collectionViewId: string,
    collectionView: notion.BaseCollectionView,
    {
      limit = 9999,
      searchQuery = '',
      userTimeZone = this._userTimeZone,
      loadContentCover = true,
      fetchOption
    }: {
      type?: notion.CollectionViewType
      limit?: number
      searchQuery?: string
      userTimeZone?: string
      userLocale?: string
      loadContentCover?: boolean
      fetchOption?: types.FetchOption
    } = {}
  ) {
    const type = collectionView?.type
    const isBoardType = type === 'board'
    const groupBy = isBoardType ? collectionView?.format?.board_columns_by : collectionView?.format?.collection_group_by

    let filters = []
    if (collectionView?.format?.property_filters)
      filters = collectionView.format?.property_filters.map(filterObj => {
        //get the inner filter
        return {
          filter: filterObj?.filter?.filter,
          property: filterObj?.filter?.property
        }
      })

    //Fixes formula filters from not working
    if (collectionView?.query2?.filter?.filters) filters.push(...collectionView.query2.filter.filters)

    let loader: unknown = {
      type: 'reducer',
      reducers: {
        collection_group_results: {
          type: 'results',
          limit,
          loadContentCover
        }
      },
      sort: [],
      ...collectionView?.query2,
      filter: {
        filters: filters,
        operator: 'and'
      },
      searchQuery,
      userTimeZone
    }

    if (groupBy) {
      const groups = collectionView?.format?.board_columns || collectionView?.format?.collection_groups || []
      const iterators = [isBoardType ? 'board' : 'group_aggregation', 'results']
      const operators = {
        checkbox: 'checkbox_is',
        url: 'string_starts_with',
        text: 'string_starts_with',
        select: 'enum_is',
        multi_select: 'enum_contains',
        created_time: 'date_is_within',
        ['undefined']: 'is_empty'
      }

      const reducersQuery = {}
      for (const group of groups) {
        const {
          property,
          value: { value, type }
        } = group

        for (const iterator of iterators) {
          const iteratorProps =
            iterator === 'results'
              ? {
                  type: iterator,
                  limit
                }
              : {
                  type: 'aggregation',
                  aggregation: {
                    aggregator: 'count'
                  }
                }

          const isUncategorizedValue = typeof value === 'undefined'
          const isDateValue = value?.range
          // TODO: review dates reducers
          const queryLabel = isUncategorizedValue
            ? 'uncategorized'
            : isDateValue
            ? value.range?.start_date || value.range?.end_date
            : value?.value || value

          const queryValue = !isUncategorizedValue && (isDateValue || value?.value || value)

          reducersQuery[`${iterator}:${type}:${queryLabel}`] = {
            ...iteratorProps,
            filter: {
              operator: 'and',
              filters: [
                {
                  property,
                  filter: {
                    operator: !isUncategorizedValue ? operators[type] : 'is_empty',
                    ...(!isUncategorizedValue && {
                      value: {
                        type: 'exact',
                        value: queryValue
                      }
                    })
                  }
                }
              ]
            }
          }
        }
      }

      const reducerLabel = isBoardType ? 'board_columns' : `${type}_groups`
      loader = {
        type: 'reducer',
        reducers: {
          [reducerLabel]: {
            type: 'groups',
            groupBy,
            ...(collectionView?.query2?.filter && {
              filter: collectionView?.query2?.filter
            }),
            groupSortPreference: groups.map(group => group?.value),
            limit
          },
          ...reducersQuery
        },
        ...collectionView?.query2,
        searchQuery,
        userTimeZone,
        filter: { filters, operator: 'and' }
      }
    }

    return this.fetch<notion.CollectionInstance>({
      endpoint: 'queryCollection',
      body: {
        collection: { id: collectionId },
        collectionView: { id: collectionViewId },
        loader
      },
      fetchOption
    })
  }

  public async getUsers(userIds: string[], fetchOption?: types.FetchOption) {
    return this.fetch<notion.RecordValues<notion.User>>({
      endpoint: 'getRecordValues',
      body: { requests: userIds.map(id => ({ id, table: 'notion_user' })) },
      fetchOption
    })
  }

  public async getBlocks(blockIds: string[], fetchOption?: types.FetchOption) {
    return this.fetch<notion.PageChunk>({
      endpoint: 'syncRecordValues',
      body: { requests: blockIds.map(blockId => ({ table: 'block', id: blockId, version: -1 })) },
      fetchOption
    })
  }

  public async getSignedFileUrls(urls: types.SignedUrlRequest[], fetchOption?: types.FetchOption) {
    return this.fetch<types.SignedUrlResponse>({
      endpoint: 'getSignedFileUrls',
      body: { urls },
      fetchOption
    })
  }

  public async search(params: notion.SearchParams, fetchOption?: types.FetchOption) {
    const body = {
      type: 'BlocksInAncestor',
      source: 'quick_find_public',
      ancestorId: parsePageId(params.ancestorId),
      sort: { field: 'relevance' },
      limit: params.limit || 20,
      query: params.query,
      filters: {
        isDeletedOnly: false,
        isNavigableOnly: false,
        excludeTemplates: true,
        requireEditPermissions: false,
        ancestors: [],
        createdBy: [],
        editedBy: [],
        lastEditedTime: {},
        createdTime: {},
        ...params.filters
      }
    }

    return this.fetch<notion.SearchResults>({
      endpoint: 'search',
      body,
      fetchOption
    })
  }

  public async fetch<T>({
    endpoint,
    body,
    fetchOption,
    headers: clientHeaders
  }: {
    endpoint: string
    body: object
    fetchOption?: types.FetchOption
    headers?: HeadersInit
  }): Promise<T> {
    const headers: HeadersInit = {
      ...clientHeaders,
      ...fetchOption?.headers,
      'Content-Type': 'application/json'
    }

    if (this._authToken) headers['cookie'] = `token_v2=${this._authToken}`
    if (this._activeUser) headers['x-notion-active-user-header'] = this._activeUser

    const url = `${this._apiBaseUrl}/${endpoint}`
    const requestInit = {
      method: 'post',
      body: JSON.stringify(body),
      headers,
      ...fetchOption
    }
    if (fetchOption?.timeout !== undefined) {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), fetchOption.timeout)
      requestInit.signal = ctrl.signal
    }

    return fetch(url, requestInit).then(res => res.json())
  }
}
