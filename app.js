/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request'),
  _ = require('lodash');

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = process.env.MESSENGER_APP_SECRET;

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN);

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN);

// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = (process.env.SERVER_URL);

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam, 
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
const foodKeywords = ['hungry', 'food', 'meal', 'snack', 'cuisine', 'drink', 'chow', 'breakfast', 'lunch', 'dinner', 'brunch', 'buffet'];

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    // TODO: for user experience rating
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
    return;
  }

  if (messageText) {
    // check for keywords
    if (_.some(foodKeywords, (word) => {
      return _.includes(_.toLower(messageText), word);
    })) {
      sendRestaurantRecommendation(senderID);
    } else {
      sendTextMessage(senderID, "I'm not sure what you mean");
    }
  }
}

function sendRestaurantRecommendation(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "Campus Pizza",
            subtitle: "Call us for all your pizza needs!",
            item_url: "http://www.campuspizza.ca/",               
            image_url: SERVER_URL + "/assets/campus_pizza.png",
            buttons: [{
              type: "web_url",
              url: "http://www.campuspizza.ca/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "I want this!",
              payload: "restaurant_campus_pizza",
            }],
          }, {
            title: "Foodie Fruitie",
            subtitle: "Ramen X Juice X Sushi",
            item_url: "http://foodiefruitie.com/",               
            image_url: SERVER_URL + "/assets/foodie_fruitie.png",
            buttons: [{
              type: "web_url",
              url: "http://foodiefruitie.com/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "I want this!",
              payload: "restaurant_foodie_fruitie"
            }],
          }, {
            title: "Williams Fresh Cafe",
            subtitle: "Canada's leading fast casual fresh food cafe",
            item_url: "http://williamsfreshcafe.com/",               
            image_url: SERVER_URL + "/assets/williams.png",
            buttons: [{
              type: "web_url",
              url: "http://williamsfreshcafe.com/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "I want this!",
              payload: "restaurant_williams"
            }],
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

function sendRecommendationsForRestaurant(recipientId, restaurant) {
  const recommendations = {
    "restaurant_campus_pizza": [{
      title: "Vegetarian Pizza",
      subtitle: "4.99",            
      image_url: SERVER_URL + "/assets/vegetarian_pizza.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|Vegetarian Pizza|4.99|"+SERVER_URL + "/assets/vegetarian_pizza.png",
      }],
    }, {
      title: "Cheese Pizza",
      subtitle: "4.99",            
      image_url: SERVER_URL + "/assets/cheese_pizza.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|Cheese Pizza|4.99|"+SERVER_URL + "/assets/cheese_pizza.png",
      }],
    }, {
      title: "Pepperoni Pizza",
      subtitle: "4.99",            
      image_url: SERVER_URL + "/assets/pepperoni_pizza.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|Pepperoni Pizza|4.99|"+SERVER_URL + "/assets/pepperoni_pizza.png",
      }],
    }],
    "restaurant_foodie_fruitie": [{
      title: "Teriyaki Salmon",
      subtitle: "9.99",            
      image_url: SERVER_URL + "/assets/teriyaki_salmon.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|Teriyaki Salmon|9.99|"+SERVER_URL + "/assets/teriyaki_salmon.png",
      }],
    }, {
      title: "BBQ Pork Fried Rice",
      subtitle: "9.99",            
      image_url: SERVER_URL + "/assets/pork_fried_rice.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|BBQ Pork Fried Rice|9.99|"+SERVER_URL + "/assets/pork_fried_rice.png",
      }],
    }, {
      title: "Curry Ramen",
      subtitle: "9.99",            
      image_url: SERVER_URL + "/assets/curry_ramen.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|Curry Ramen|9.99|"+SERVER_URL + "/assets/curry_ramen.png",
      }],
    }],
    "restaurant_williams": [{
      title: "Chicken Quesadilla",
      subtitle: "6.99",            
      image_url: SERVER_URL + "/assets/chicken_quesadilla.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|Chicken Quesadilla|6.99|"+SERVER_URL + "/assets/chicken_quesadilla.png",
      }],
    }, {
      title: "William's Big Breakfast",
      subtitle: "9.99",            
      image_url: SERVER_URL + "/assets/big_breakfast.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|William's Big Breakfast|9.99|"+SERVER_URL + "/assets/big_breakfast.png",
      }],
    }, {
      title: "Mac'n'Cheese",
      subtitle: "4.99",            
      image_url: SERVER_URL + "/assets/mac_cheese.png",
      buttons: [{
        type: "postback",
        title: "I want this!",
        payload: "item|Mac'n'Cheese|4.99|"+SERVER_URL + "/assets/mac_cheese.png",
      }],
    }],
  };

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: recommendations[restaurant],
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;

  if(payload) {
    if (_.startsWith(payload, "restaurant")) {
      sendTextMessage(senderID, "Want any of these?");
      // Send a list of recommendations for the particular restaurant
      sendRecommendationsForRestaurant(senderID, payload);
    } else if (_.startsWith(payload, "item")) {
      const payloadData = _.split(payload, '|');
      const food = payloadData[1];
      const price = payloadData[2];
      const img_url = payloadData[3];
      sendTextMessage(senderID, "We got your order!");
      sendOrderReceipt(senderID, food, price, img_url);
    } else {
      sendTextMessage(senderID, "Sorry, we couldn't understand your message");
    }
  }

  console.log("Received postback for user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);
}

function sendOrderReceipt(recipientId, food, price, img_url) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "David Dong",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",
          elements: [{
            title: food,
            quantity: 1,
            price: _.round(price*1, 2),
            currency: "CAD",
            image_url: img_url,
          }],
          address: {
            street_1: "208 Sunview St",
            street_2: "",
            city: "Waterloo",
            postal_code: "A1A 1A1",
            state: "ON",
            country: "CA"
          },
          summary: {
            subtotal: _.round(price*1, 2),
            shipping_cost: 0.00,
            total_tax: _.round(price*0.13, 2),
            total_cost: _.round(price*1.13, 2),
          }
        }
      }
    }
  };

  callSendAPI(messageData); 
}

function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is test text",
          buttons:[{
            type: "web_url",
            url: "https://www.oculus.com/en-us/rift/",
            title: "Open Web URL"
          }, {
            type: "postback",
            title: "Trigger Postback",
            payload: "DEVELOPER_DEFINED_PAYLOAD"
          }, {
            type: "phone_number",
            title: "Call Phone Number",
            payload: "+16505551234"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "rift",
            subtitle: "Next-generation virtual reality",
            item_url: "https://www.oculus.com/en-us/rift/",               
            image_url: SERVER_URL + "/assets/rift.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/rift/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for first bubble",
            }],
          }, {
            title: "touch",
            subtitle: "Your Hands, Now in VR",
            item_url: "https://www.oculus.com/en-us/touch/",               
            image_url: SERVER_URL + "/assets/touch.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/touch/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for second bubble",
            }]
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Peter Chang",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",        
          timestamp: "1428444852", 
          elements: [{
            title: "Oculus Rift",
            subtitle: "Includes: headset, sensor, remote",
            quantity: 1,
            price: 599.00,
            currency: "USD",
            image_url: SERVER_URL + "/assets/riftsq.png"
          }, {
            title: "Samsung Gear VR",
            subtitle: "Frost White",
            quantity: 1,
            price: 99.99,
            currency: "USD",
            image_url: SERVER_URL + "/assets/gearvrsq.png"
          }],
          address: {
            street_1: "1 Hacker Way",
            street_2: "",
            city: "Menlo Park",
            postal_code: "94025",
            state: "CA",
            country: "US"
          },
          summary: {
            subtotal: 698.99,
            shipping_cost: 20.00,
            total_tax: 57.67,
            total_cost: 626.66
          },
          adjustments: [{
            name: "New Customer Discount",
            amount: -50
          }, {
            name: "$100 Off Coupon",
            amount: -100
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What's your favorite movie genre?",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Action",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
        },
        {
          "content_type":"text",
          "title":"Comedy",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_COMEDY"
        },
        {
          "content_type":"text",
          "title":"Drama",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons:[{
            type: "account_link",
            url: SERVER_URL + "/authorize"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });  
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;

