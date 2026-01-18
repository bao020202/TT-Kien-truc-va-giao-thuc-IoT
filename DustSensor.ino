#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "DHT.h"
#include <math.h>  

//  WiFi 
const char* ssid = "Nha Giao 2.4GHZ";
const char* password = "quangbinh";

//  MQTT 
const char* mqtt_server = "428a5debf9b5466995e30be2e9a985c5.s1.eu.hivemq.cloud";
const int mqtt_port = 8883;
const char* mqtt_user = "Duy_vuong";
const char* mqtt_pass = "Duyvuong1612#";
#define DHTPIN 27
#define DHTTYPE DHT11
#define MQ7_PIN 35
#define DUST_LED_PIN 4   
#define DUST_VO_PIN  32
#define LED_LAMP   16
#define LED_FAN    17
#define LED_VACUUM 18
#define LED_AIR    19
// MQTT Topics 
const char* TOPIC_SENSOR    = "sensor";     
const char* TOPIC_STATE     = "state";     
const char* TOPIC_THRESHOLD = "threshold";  
const char* TOPIC_MODE      = "mode";      
const char* TOPIC_DEVICES   = "devices"; 

WiFiClientSecure secureClient;
PubSubClient mqtt(secureClient);
DHT dht(DHTPIN, DHTTYPE);

// Mode 
enum Mode { MODE_MANUAL, MODE_AUTO };
volatile Mode currentMode = MODE_MANUAL;

//  Thresholds 
float thrTemp = 50;
float thrHumi = 50;
float thrDust = 70;
float thrCO   = 90;  

// Device state 
struct DeviceState {
  int lamp;
  int fan;
  int vacuum;
  int air;
};

DeviceState dev = {0,0,0,0};
DeviceState lastPublished = {-1,-1,-1,-1};

#define MQ7_RL 10000.0f
float MQ7_R0 = 10000.0f;   
float co_ema_ppm = 0.0f;    
float co_baseline_ppm = 0.0f;   
bool baseline_ready = false;   // ✅ FIX: khai báo biến còn thiếu

const float EMA_ALPHA  = 0.15f; 
const float BASE_ALPHA = 0.01f;  
const float BASE_MAX   = 120.0f; 
const float MAX_STEP   = 15.0f; 

// WiFi connect 
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\n WiFi connected");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

// MQTT connect 
void connectMQTT() {
  mqtt.setServer(mqtt_server, mqtt_port);

  while (!mqtt.connected()) {
    String clientId = String("esp32_") + String((uint32_t)ESP.getEfuseMac(), HEX);
    Serial.print("Connecting MQTT TLS... ");
    if (mqtt.connect(clientId.c_str(), mqtt_user, mqtt_pass)) {
      Serial.println("connected");

      mqtt.subscribe(TOPIC_THRESHOLD);
      mqtt.subscribe(TOPIC_MODE);
      mqtt.subscribe(TOPIC_DEVICES);
      Serial.println(" Subscribed: threshold, mode, devices");
    } else {
      Serial.print("failed rc=");
      Serial.print(mqtt.state());
      Serial.println(" retry...");
      delay(1500);
    }
  }
}

void applyOutputs(const DeviceState &s) {
  digitalWrite(LED_LAMP,   s.lamp   ? HIGH : LOW);
  digitalWrite(LED_FAN,    s.fan    ? HIGH : LOW);
  digitalWrite(LED_VACUUM, s.vacuum ? HIGH : LOW);
  digitalWrite(LED_AIR,    s.air    ? HIGH : LOW);
}

void publishStateIfChanged() {
  if (dev.lamp == lastPublished.lamp &&
      dev.fan == lastPublished.fan &&
      dev.vacuum == lastPublished.vacuum &&
      dev.air == lastPublished.air) return;

  StaticJsonDocument<96> doc;
  doc["lamp"] = dev.lamp;
  doc["fan"] = dev.fan;
  doc["vacuum"] = dev.vacuum;
  doc["air"] = dev.air;

  char payload[96];
  size_t n = serializeJson(doc, payload);
  mqtt.publish(TOPIC_STATE, payload, n);

  lastPublished = dev;
  Serial.print(" state: ");
  Serial.println(payload);
}

float readDustUGM3() {
  digitalWrite(DUST_LED_PIN, LOW);
  delayMicroseconds(280);

  int adcValue = analogRead(DUST_VO_PIN);

  delayMicroseconds(40);
  digitalWrite(DUST_LED_PIN, HIGH);
  delayMicroseconds(9680);

  float voltage = adcValue * (3.3f / 4095.0f);

  float dust_mg = (voltage - 0.9f) / 5.0f;
  if (dust_mg < 0) dust_mg = 0;

  return dust_mg * 1000.0f;
}

float mq7_getVoltageFromADC(int adc) {
  return adc * (3.3f / 4095.0f);
}

float mq7_getRsFromADC(int adc) {
  float v = mq7_getVoltageFromADC(adc);
  if (v < 0.01f) v = 0.01f;   
  if (v > 3.29f) v = 3.29f;   
  return MQ7_RL * (3.3f - v) / v;
}

void mq7_calibrateR0() {
  Serial.println("Calibrating MQ-7 R0 (normal air)...");
  float rs_sum = 0;
  const int N = 50;

  for (int i = 0; i < N; i++) {
    int adc = analogRead(MQ7_PIN);
    rs_sum += mq7_getRsFromADC(adc);
    delay(100);
  }

  MQ7_R0 = rs_sum / N;
  Serial.print(" MQ-7 R0 = ");
  Serial.println(MQ7_R0, 2);
}

// ppm thô (ước lượng), chưa ổn định
float mq7_getCOppm_raw(int adc) {
  float rs = mq7_getRsFromADC(adc);
  float ratio = rs / MQ7_R0;

  float ppm = 100.0f * pow(ratio, -1.5f);
  if (ppm < 0) ppm = 0;
  return ppm;
}

float mq7_stabilizeCOppm(float raw_ppm) {
  if (co_ema_ppm == 0.0f) co_ema_ppm = raw_ppm;
  co_ema_ppm = EMA_ALPHA * raw_ppm + (1.0f - EMA_ALPHA) * co_ema_ppm;

  if (!baseline_ready) {
    co_baseline_ppm = co_ema_ppm;
    baseline_ready = true;
  } else {
    if (co_ema_ppm < BASE_MAX) {
      co_baseline_ppm = BASE_ALPHA * co_ema_ppm + (1.0f - BASE_ALPHA) * co_baseline_ppm;
    }
  }

  float ppm = co_ema_ppm - co_baseline_ppm;
  if (ppm < 0) ppm = 0;

  static float last_ppm = 0.0f;
  if (ppm > last_ppm + MAX_STEP) ppm = last_ppm + MAX_STEP;
  if (ppm < last_ppm - MAX_STEP) ppm = last_ppm - MAX_STEP;
  last_ppm = ppm;

  return ppm;
}

void runAutoLogic(float t, float h, float dust, float co_ppm) {
  bool overTemp = t > thrTemp;
  bool overHumi = h > thrHumi;
  bool overDust = dust > thrDust;
  bool overCO   = co_ppm > thrCO;

  dev.lamp = (overTemp || overHumi || overDust || overCO) ? 1 : 0;
  dev.vacuum = overDust ? 1 : 0;
  dev.fan = overCO ? 1 : 0;
  dev.air = (overTemp || overHumi) ? 1 : 0;
  applyOutputs(dev);
  publishStateIfChanged();
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  msg.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.print("JSON parse error on topic ");
    Serial.print(topic);
    Serial.print(": ");
    Serial.println(err.c_str());
    return;
  }

  if (strcmp(topic, TOPIC_MODE) == 0) {
    const char* m = doc["mode"] | "manual";
    currentMode = (strcmp(m, "auto") == 0) ? MODE_AUTO : MODE_MANUAL;
    Serial.print("mode = ");
    Serial.println(currentMode == MODE_AUTO ? "auto" : "manual");
    return;
  }

  if (strcmp(topic, TOPIC_THRESHOLD) == 0) {
    if (doc.containsKey("temp")) thrTemp = doc["temp"].as<float>();
    if (doc.containsKey("humi")) thrHumi = doc["humi"].as<float>();
    if (doc.containsKey("dust")) thrDust = doc["dust"].as<float>();
    if (doc.containsKey("co"))   thrCO   = doc["co"].as<float>(); // ppm ước lượng ổn định

    Serial.print("threshold updated: ");
    Serial.print("temp="); Serial.print(thrTemp);
    Serial.print(" humi="); Serial.print(thrHumi);
    Serial.print(" dust="); Serial.print(thrDust);
    Serial.print(" co(ppm)="); Serial.println(thrCO);
    return;
  }

  if (strcmp(topic, TOPIC_DEVICES) == 0) {
    if (currentMode != MODE_MANUAL) {
      Serial.println(" ignore devices (not manual mode)");
      return;
    }

    dev.lamp   = (doc["lamp"]   | dev.lamp) ? 1 : 0;
    dev.fan    = (doc["fan"]    | dev.fan) ? 1 : 0;
    dev.vacuum = (doc["vacuum"] | dev.vacuum) ? 1 : 0;
    dev.air    = (doc["air"]    | dev.air) ? 1 : 0;

    applyOutputs(dev);
    publishStateIfChanged();

    Serial.print("devices applied (manual): ");
    Serial.println(msg);
    return;
  }
}

void setup() {
  Serial.begin(115200);

  // Sensor init
  pinMode(DUST_LED_PIN, OUTPUT);
  digitalWrite(DUST_LED_PIN, HIGH);

  analogSetAttenuation(ADC_11db);
  analogReadResolution(12);

  dht.begin();

  // Device LED init
  pinMode(LED_LAMP, OUTPUT);
  pinMode(LED_FAN, OUTPUT);
  pinMode(LED_VACUUM, OUTPUT);
  pinMode(LED_AIR, OUTPUT);
  applyOutputs(dev);

  connectWiFi();
  secureClient.setInsecure();
  mqtt.setCallback(mqttCallback);
  connectMQTT();
  mq7_calibrateR0();
}

unsigned long lastSend = 0;
const unsigned long SEND_INTERVAL_MS = 2000;

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();

    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (isnan(t) || isnan(h)) {
      Serial.println(" DHT read failed");
      return;
    }

    int co_adc = analogRead(MQ7_PIN);
    float co_ppm_raw = mq7_getCOppm_raw(co_adc);
    float co_ppm = mq7_stabilizeCOppm(co_ppm_raw);

    float dust = readDustUGM3();
    int co_int = (int)lroundf(co_ppm);
    int dust_int = (int)lroundf(dust);
    StaticJsonDocument<128> sdoc;
    sdoc["temperature"] = t;
    sdoc["humidity"] = h;
    sdoc["co"] = co_int;      
    sdoc["dust"] = dust_int;   

    char spayload[128];
    size_t n = serializeJson(sdoc, spayload);
    mqtt.publish(TOPIC_SENSOR, spayload, n);

    Serial.print("sensor: ");
    Serial.println(spayload);

    // AUTO logic
    if (currentMode == MODE_AUTO) {
      runAutoLogic(t, h, dust, co_ppm); 
    }
  }
}
