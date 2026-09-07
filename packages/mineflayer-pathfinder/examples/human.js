// Walk to whoever says "come" the way a player would: curved steering, mouse-like head turns,
// sprint after a short delay, coast to a stop, then look at them.

const mineflayer = require('mineflayer')
const { pathfinder, createHuman } = require('mineflayer-pathfinder')
const bot = mineflayer.createBot({ username: 'Player' })

bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
  // The seed fixes this bot's personality (reaction time, sprint delay, jump rate, glances, ...)
  const human = createHuman(bot, { seed: 42 })

  bot.on('chat', async (username, message) => {
    if (username === bot.username || message !== 'come') return

    const target = bot.players[username] ? bot.players[username].entity : null
    if (!target) return bot.chat("I don't see you !")

    try {
      await human.walkTo(target.position, { faceAt: target.position.offset(0, 1.62, 0) })
      bot.chat('Hi!')
    } catch (err) {
      bot.chat(`Could not get there: ${err.message}`)
    }
  })
})
