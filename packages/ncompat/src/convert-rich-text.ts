import { convertColor } from './convert-color'

import type { SubDecoration, Decoration } from '@texonom/ntypes'
import type { RichText, RichTextItem } from './types'

export function convertRichText(richText: RichText): Decoration[] {
  return richText.map(convertRichTextItem).filter(Boolean)
}

export function convertRichTextItem(richTextItem: RichTextItem): Decoration {
  const subdecorations: SubDecoration[] = []

  if (richTextItem.annotations.bold) subdecorations.push(['b'])
  if (richTextItem.annotations.italic) subdecorations.push(['i'])
  if (richTextItem.annotations.strikethrough) subdecorations.push(['s'])
  if (richTextItem.annotations.underline) subdecorations.push(['_'])
  if (richTextItem.annotations.code) subdecorations.push(['c'])
  if (richTextItem.annotations.color !== 'default') subdecorations.push(['h', convertColor(richTextItem.annotations.color)])

  const details = richTextItem[richTextItem.type]
  if (details) if (details.link) subdecorations.push(['a', details.link.url])

  switch (richTextItem.type) {
    case 'text':
      if (subdecorations.length) return [richTextItem.text.content, subdecorations]
      else return [richTextItem.text.content]

    case 'equation':
      if (richTextItem.equation?.expression) subdecorations.unshift(['e', richTextItem.equation.expression])
      return ['⁍', subdecorations]

    case 'mention': {
      const { mention } = richTextItem

      if (mention)
        switch (mention.type) {
          case 'link_preview':
            // TODO: this should be an eoi, but we don't hae the proper data
            subdecorations.push(['a', mention.link_preview.url])
            break

          case 'page':
            subdecorations.push(['p', mention.page.id])
            return ['‣', subdecorations]

          case 'database':
            subdecorations.push(['p', mention.database.id])
            return ['‣', subdecorations]

          case 'date':
            subdecorations.unshift([
              'd',
              {
                type: 'date', // TODO
                start_date: mention.date.start,
                end_date: mention.date.end,
                time_zone: mention.date.time_zone
              }
            ])
            break

          case 'user':
            subdecorations.push(['u', mention.user.id])
            break

          case 'template_mention':
            // TODO
            // subdecorations.push(['m', mention.template_mention.type])
            break

          default:
            // TODO
            break
        }

      return [richTextItem.plain_text, subdecorations]
    }

    default:
      return ['']
  }
}
